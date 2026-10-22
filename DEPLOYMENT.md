# Deploying gmail-gdocs-mcp on Render

A plan for running the server in **Streamable HTTP** mode as a Render Web Service, so MCP clients on other machines can reach it at `https://<name>.onrender.com/mcp`.

Status: **in progress**: code and Blueprint pushed to GitHub (`main`); Render service not yet created. The build and runtime steps below were tested locally under Render-like conditions on 2026-10-22 (see [Pre-deployment test results](#pre-deployment-test-results)). Render's UI labels, plans and prices change over time, so check them against the [Render docs](https://render.com/docs) as you go.

---

## 1. Decide first: is a deployment worth it?

Deploying exposes **"send email and edit Docs as your Google account"** on the public internet, protected by one bearer token. Anyone holding `MCP_AUTH_TOKEN` acts as that account. Go ahead only if you need remote access.

**Which clients can use it.** v1 authenticates with a static `Authorization: Bearer <token>` header.

| Client | Works with the deployed server? |
|--------|---------------------------------|
| Claude Code (`claude mcp add --transport http … --header`) | Yes |
| Cursor (`url` + `headers`) | Yes |
| Gemini CLI (`httpUrl` + `headers`) | Yes |
| MCP Inspector (Streamable HTTP + custom header) | Yes |
| claude.ai custom connectors, ChatGPT connectors | **Probably not yet.** As far as I know, their connector UIs offer OAuth or no auth, not a custom header. Check their current docs. |

Local clients (Claude Desktop, Cursor and others on this Mac) don't need a deployment; they run the server over stdio.

**If ChatGPT or claude.ai is the goal,** the server first needs MCP's OAuth-based authorization (the v2 item in the spec). Do not switch to unauthenticated mode to get around this. With no auth, anyone who finds the URL can send email as you.

---

## 2. Prerequisites

1. **Google OAuth works locally.** Done: `npm run auth` succeeded and `google_auth_status` reports `authorized: true`.
2. **Deal with the 7-day expiry first (strongly recommended).** The OAuth app is in *Testing*, so the refresh token dies every 7 days. Locally that's a 30-second `npm run auth`. On Render it also means re-uploading the token file each week (see [Runbook](#7-runbook)). Two ways out:
   - Publish the app. This needs a home page and privacy policy URL on the Branding page; a free static site such as a Render Static Site or GitHub Pages works.
   - Accept the weekly re-upload.
3. **A Git repository.** Render deploys from GitHub, GitLab or Bitbucket. This folder isn't a Git repo yet:
   ```bash
   cd gmail-gdocs-mcp
   git init && git add . && git status   # confirm .env and token.json are NOT listed
   git commit -m "Initial commit"
   # create a PRIVATE repo on GitHub, then:
   git remote add origin git@github.com:<you>/gmail-gdocs-mcp.git && git push -u origin main
   ```
   `.gitignore` already excludes `.env`, `token.json`, `node_modules/` and `dist/`. The real token lives in `~/.config/gmail-gdocs-mcp/`, outside the repo.
4. **A long random bearer token**, generated with `openssl rand -hex 32`. Store it in a password manager; clients need it.

---

## 3. Repository changes (small, optional but recommended)

| File | Change | Why |
|------|--------|-----|
| `.node-version` | `22` | Pins Render's Node version; `engines: ">=20"` alone could pick a newer major. |
| `render.yaml` | Blueprint below | The service is defined in code and can be recreated with one click. |

```yaml
# render.yaml
services:
  - type: web
    name: gmail-gdocs-mcp
    runtime: node
    plan: free                      # or starter: no spin-down (see §6)
    buildCommand: npm ci --include=dev && npm run build
    startCommand: node dist/index.js
    healthCheckPath: /healthz
    autoDeploy: true
    envVars:
      - key: MCP_TRANSPORT
        value: http
      - key: HOST
        value: 0.0.0.0
      - key: GOOGLE_TOKEN_PATH
        value: /etc/secrets/token.json
      - key: MCP_AUTH_TOKEN
        generateValue: true         # Render generates it; copy it from the dashboard
      - key: GOOGLE_CLIENT_ID
        sync: false                 # entered in the dashboard, never committed
      - key: GOOGLE_CLIENT_SECRET
        sync: false
      - key: ALLOWED_RECIPIENT_DOMAINS
        sync: false
      - key: RATE_LIMIT_EMAILS_PER_HOUR
        value: "10"
      - key: LOG_LEVEL
        value: info
```

Both files are in the repository. Render supplies `PORT`, which the server already reads. Two small server changes make Render operations clearer:

- **Startup credential check.** Right after `server started`, the log says either `google credentials found` or `google credentials not ready …` with the exact problem (e.g. the secret file is missing), without calling Google.
- **Read-only token file.** When a refreshed access token can't be written back (as with Render secret files), the server keeps it in memory and logs one explanatory warning, not one per refresh.

---

## 4. Render service configuration

If you're not using the Blueprint, create it by hand: **New → Web Service → connect the repo**.

| Setting | Value | Notes |
|---------|-------|-------|
| Runtime | Node | |
| Build command | `npm ci --include=dev && npm run build` | **`--include=dev` is required.** If `NODE_ENV=production` is set, plain `npm ci` skips TypeScript and the build fails with `tsc: command not found` (reproduced locally). |
| Start command | `node dist/index.js` | |
| Health check path | `/healthz` | Returns `{"status":"ok"}`, unauthenticated, reveals nothing. |
| Instances | **1** | Rate limits are per process, so more instances multiply the email allowance. |

### Environment variables

| Variable | Value | Required |
|----------|-------|----------|
| `MCP_TRANSPORT` | `http` | yes |
| `HOST` | `0.0.0.0` | **yes**: the default `127.0.0.1` is unreachable from Render's proxy |
| `MCP_AUTH_TOKEN` | output of `openssl rand -hex 32` | yes (the server refuses to start without one of 16+ chars) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from `.env` | yes |
| `GOOGLE_TOKEN_PATH` | `/etc/secrets/token.json` | yes |
| `ALLOWED_RECIPIENT_DOMAINS` | e.g. `gmail.com` or your domains | strongly recommended |
| `RATE_LIMIT_EMAILS_PER_HOUR` | e.g. `10` | recommended (default 30) |
| `ALLOWED_DOCUMENT_IDS` | your doc IDs | optional hardening |
| `REQUIRE_DRY_RUN_FIRST` | `true` | optional hardening |

Do **not** set `MCP_ALLOW_UNAUTHENTICATED`. It's rejected on `0.0.0.0` anyway.

### Secret file: the Google token

*Environment → Secret Files → Add*. Filename `token.json`; contents are the whole of `~/.config/gmail-gdocs-mcp/token.json` from your Mac (`pbcopy < ~/.config/gmail-gdocs-mcp/token.json`). Render mounts it at `/etc/secrets/token.json`.

The mount is read-only. That's fine (tested): the server refreshes the access token in memory and logs a single `could not persist refreshed token; keeping it in memory …` warning, which is expected there. The refresh token in the file keeps working until it's revoked or, while the app is in Testing, until it expires after 7 days.

> [!WARNING]
> The token file grants send-as-you access. Anyone with access to this Render service's dashboard can read it. Keep the Render account to yourself and turn on 2FA.

---

## 5. Rollout and verification

1. Push the repo (with `render.yaml`) and create the Blueprint, or the Web Service by hand.
2. Add the secret file and the `sync: false` variables, then deploy.
3. Watch the deploy logs for `"msg":"server started",…,"authenticated":true` followed by `"msg":"google credentials found"`. If you see `google credentials not ready` instead, its `problem` field says what to fix (usually the secret file name or path).
4. Smoke test from your Mac (replace `<name>` and `<token>`):
   ```bash
   URL=https://<name>.onrender.com
   curl -s $URL/healthz                                  # {"status":"ok"}
   curl -s -o /dev/null -w '%{http_code}\n' -X POST $URL/mcp \
     -H 'Content-Type: application/json' -d '{}'         # 401
   curl -s -X POST $URL/mcp -H "Authorization: Bearer <token>" \
     -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"google_auth_status","arguments":{}}}'
   ```
   The last call must report `"authorized":true` for your Google account.
5. Exercise the tools with MCP Inspector (`npx -y @modelcontextprotocol/inspector`): transport *Streamable HTTP*, URL `https://<name>.onrender.com/mcp`, header `Authorization: Bearer <token>`. Run a `dry_run` email, one real email to yourself, and a `dry_run` doc append.
6. Connect a real client, e.g. Claude Code:
   ```bash
   claude mcp add --transport http gmail-gdocs https://<name>.onrender.com/mcp \
     --header "Authorization: Bearer <token>"
   ```

**Done when:** health check is green, unauthenticated requests get 401, `google_auth_status` is authorized, one real email has arrived, and one append has landed in the test doc. All of this from a client that is not on this Mac.

---

## 6. Plan and cost choices

| | Free instance | Paid instance (e.g. Starter) |
|---|---|---|
| Idle behaviour | Spins down after about 15 minutes idle; the next request waits for a cold start (up to about a minute) | Always on |
| Fit | Occasional personal use. Some clients may time out on the first call after idling; retry. | Regular use or demos |

Check Render's current pricing page; the figures above are approximate. No persistent disk is needed, because the only state is the token secret file.

---

## 7. Runbook

| Situation | Action |
|-----------|--------|
| **Tools return `AUTH_REQUIRED`** (every 7 days while the app is in Testing, or after you revoke access) | On your Mac: `npm run auth`, then `pbcopy < ~/.config/gmail-gdocs-mcp/token.json`. In Render: *Environment → Secret Files → token.json → paste → Save*, then redeploy or restart. |
| Bearer token leaked | Set a new `MCP_AUTH_TOKEN` in Render (it restarts), then update every client. |
| Suspected misuse | Suspend the service in Render, then revoke the app at <https://myaccount.google.com/permissions>, then re-run `npm run auth` and upload the new token before resuming. |
| Bad deploy | Render dashboard → *Events* → roll back to the previous deploy. |
| Debugging | Temporarily set `LOG_LEVEL=debug`; logs are JSON on stderr in Render's log view (secrets are still redacted). |

---

## 8. Security checklist

- [ ] Private Git repository; `git status` showed no `.env` or `token.json` before the first commit
- [ ] `MCP_AUTH_TOKEN` is 64 random hex characters and stored only in Render and your password manager
- [ ] `ALLOWED_RECIPIENT_DOMAINS` set; `RATE_LIMIT_EMAILS_PER_HOUR` lowered
- [ ] Exactly one instance
- [ ] 2FA on the Render and Google accounts
- [ ] Client-side tool-call confirmation enabled for `gmail_send_email`
- [ ] You know how to revoke Google access (Runbook, "Suspected misuse")

---

## Pre-deployment test results

Run locally on 2026-10-22 against a clean copy of the repo, simulating Render:

| Check | Result |
|-------|--------|
| Full test suite (`npm test`) and typecheck | 196 passed, 5 integration tests skipped (opt-in), 0 type errors |
| Clean build with `NODE_ENV=production` and plain `npm ci` | **Fails** (`tsc: command not found`), hence `--include=dev` |
| Clean build with `npm ci --include=dev && npm run build` | Pass |
| Server on `HOST=0.0.0.0 PORT=10000`, credentials from env vars only (no `.env`) | Starts; `/healthz` ok |
| No bearer token / wrong token | HTTP 401 / 401 |
| `Host: gmail-gdocs-mcp.onrender.com` header with a valid token | Accepted |
| Read-only, expired token file (like `/etc/secrets`) | Token refreshed in memory; `google_auth_status` authorized; exactly one "could not persist" warning across several calls; no crash |
| Secret file missing | Startup log: `google credentials not ready` naming `/etc/secrets/token.json`; tools return `AUTH_REQUIRED` with upload guidance |
| `ALLOWED_RECIPIENT_DOMAINS=gmail.com`, recipient `@example.org` | `POLICY_BLOCKED`, nothing sent |
| Email and Docs dry runs against the real Google APIs | Pass |

Not tested: Render itself (no account access from here), and cold-start behaviour of specific clients.
