# gmail-gdocs-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets any MCP-compatible agent:

1. **Send email** from your Gmail account (`gmail_send_email`).
2. **Append text** to the end of an existing Google Doc (`gdocs_append_text`).
3. **Check authorization** (`google_auth_status`).

It is client-agnostic: it works with Claude (Desktop, Claude Code, claude.ai connectors), ChatGPT connectors, Gemini CLI, Cursor, Antigravity, MCP Inspector, and anything else that speaks MCP over **stdio** or **Streamable HTTP**. Nothing in it depends on a specific model vendor.

---

## Contents

- [Quick start](#quick-start)
- [Google Cloud setup](#google-cloud-setup)
- [Authorize](#authorize)
- [Configuration](#configuration)
- [Client configuration](#client-configuration)
- [Tools](#tools)
- [Errors](#errors)
- [Security recommendations](#security-recommendations)
- [Manual testing with MCP Inspector](#manual-testing-with-mcp-inspector)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Quick start

```bash
# 1. Create an OAuth "Desktop app" client in Google Cloud (see below), then:
export GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
export GOOGLE_CLIENT_SECRET=xxxxx

# 2. Authorize once (opens your browser; tokens are saved with mode 0600)
npx -y gmail-gdocs-mcp auth

# 3. Add the server to your client (example: Claude Desktop, Cursor, Gemini CLI, Antigravity)
```

```json
{
  "mcpServers": {
    "gmail-gdocs": {
      "command": "npx",
      "args": ["-y", "gmail-gdocs-mcp"],
      "env": {
        "GOOGLE_CLIENT_ID": "xxxxx.apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "xxxxx",
        "ALLOWED_RECIPIENT_DOMAINS": "mycompany.com"
      }
    }
  }
}
```

Requires Node.js 20 or newer. To run from a checkout instead of npm: `npm ci && npm run build`, then use `node /absolute/path/to/dist/index.js` as the command.

---

## Google Cloud setup

1. **Create a project.** In the [Google Cloud console](https://console.cloud.google.com/), create a new project (or pick an existing one).
2. **Enable the APIs.** Go to *APIs & Services → Library* and enable both:
   - **Gmail API**
   - **Google Docs API**
3. **Configure the OAuth consent screen** (*APIs & Services → OAuth consent screen*, called *Google Auth Platform* in newer consoles):
   - **User type:** *Internal* if you are in a Google Workspace organization and only its users will authorize; otherwise *External*.
   - Fill in the app name and support email.
   - **Scopes:** add `.../auth/gmail.send`, `.../auth/documents`, `openid` and `.../auth/userinfo.email`.
   - For *External* apps in *Testing* status, add your Google account under **Test users**.
4. **Create the OAuth client.** *APIs & Services → Credentials → Create credentials → OAuth client ID*, application type **Desktop app**. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

> [!IMPORTANT]
> **The 7-day refresh-token expiry.** If the consent screen is left in **Testing** publishing status with the **External** user type, Google expires refresh tokens after **7 days**. The server will then return `AUTH_REQUIRED` until you re-run `auth`. To avoid this, either:
> - **Publish the app** (*OAuth consent screen → Publish app*, "In production"). Because `gmail.send` is a sensitive scope, Google shows an "unverified app" warning until it is verified. For personal use you can click *Advanced → Go to (app name)*.
> - Or use an **Internal** app in a Google Workspace organization, which has no 7-day limit.

### Scopes (least privilege)

| Scope | Why |
|-------|-----|
| `https://www.googleapis.com/auth/gmail.send` | Send only. The server cannot read, search or delete mail. |
| `https://www.googleapis.com/auth/documents` | Edit existing Docs. (`drive.file` is not enough: it only covers files the app created or the user opened through it.) |
| `openid`, `email` | Non-sensitive. Used only to learn which account was authorized, since `gmail.send` cannot read the Gmail profile. |

No other scopes are requested. The `auth` command fails if you untick a required permission on the consent screen.

### Service-account mode (Google Workspace only, optional)

Set `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` to a service-account JSON key to use it instead of OAuth.

- **Docs:** share the target document with the service account's email (`...@...iam.gserviceaccount.com`) as an Editor, or set `GOOGLE_IMPERSONATE_USER`.
- **Gmail:** requires a Workspace admin to configure [domain-wide delegation](https://support.google.com/a/answer/162106) for the service account's client ID with the `gmail.send` and `documents` scopes, plus `GOOGLE_IMPERSONATE_USER=sender@yourcompany.com`. Personal `@gmail.com` accounts cannot use this mode for Gmail.

---

## Authorize

```bash
npx -y gmail-gdocs-mcp auth            # opens the browser
npx -y gmail-gdocs-mcp auth --no-browser   # prints the URL only
```

The command starts a temporary loopback server on `127.0.0.1` (random free port), opens Google's consent screen using PKCE, exchanges the code, and writes the tokens to `GOOGLE_TOKEN_PATH` (default `~/.config/gmail-gdocs-mcp/token.json`) with file mode `0600`, inside a `0700` directory.

Run it with the **same** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_TOKEN_PATH` the server uses. Access tokens are refreshed automatically and the refreshed tokens are saved back to the file. If you re-authorize while the server is running, it picks up the new token file on the next call without a restart.

If the server starts without valid tokens, it still starts and lists its tools. Tool calls then return `AUTH_REQUIRED` with the exact command to run, and `google_auth_status` explains what is missing.

---

## Configuration

All configuration is through environment variables. A `.env` file in the working directory is also read; see [.env.example](.env.example). CLI flags (`--transport`, `--port`, `--host`) override the environment.

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_CLIENT_ID` | — | OAuth client ID (required in OAuth mode). |
| `GOOGLE_CLIENT_SECRET` | — | OAuth client secret (required in OAuth mode). |
| `GOOGLE_TOKEN_PATH` | `~/.config/gmail-gdocs-mcp/token.json` | Where tokens are stored. |
| `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` | — | Enables service-account mode. |
| `GOOGLE_IMPERSONATE_USER` | — | User to impersonate (service-account mode). |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http`. |
| `HOST` | `127.0.0.1` | HTTP bind address. |
| `PORT` | `3000` | HTTP port. The endpoint path is `/mcp`. |
| `MCP_AUTH_TOKEN` | — | Bearer token required in HTTP mode (at least 16 characters; use `openssl rand -hex 32`). |
| `MCP_ALLOW_UNAUTHENTICATED` | `false` | Allow HTTP without a token. Honoured only when `HOST` is loopback. |
| `MCP_ALLOWED_ORIGINS` | (empty) | Extra browser `Origin`s allowed in HTTP mode, comma-separated. Loopback origins are always allowed. |
| `MCP_ALLOWED_HOSTS` | (empty) | If set, only these `Host` headers (plus loopback) are accepted in HTTP mode. |
| `ALLOWED_RECIPIENT_DOMAINS` | (empty = allow all) | Comma-separated. See [domain matching](#recipient-domain-matching). |
| `ALLOWED_DOCUMENT_IDS` | (empty = allow all) | Comma-separated document IDs (exact, case-sensitive). |
| `MAX_RECIPIENTS` | `50` | Total across to, cc and bcc. |
| `MAX_ATTACHMENT_BYTES` | `10485760` | Total decoded attachment size (10 MB). |
| `RATE_LIMIT_EMAILS_PER_HOUR` | `30` | Per server instance, sliding window. |
| `RATE_LIMIT_DOC_APPENDS_PER_MINUTE` | `30` | Per server instance, sliding window. |
| `REQUIRE_DRY_RUN_FIRST` | `false` | When `true`, a real send is rejected unless an identical `dry_run` happened in the last 5 minutes. |
| `TIMEZONE` | `UTC` | IANA zone used by `timestamp_prefix`, e.g. `Europe/Berlin`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. Logs always go to stderr. |

### Recipient domain matching

Matching is case-insensitive.

- `mycompany.com` matches **exactly** `mycompany.com`, not `eu.mycompany.com`.
- `*.mycompany.com` matches **any subdomain** (`eu.mycompany.com`, `a.b.mycompany.com`), not the apex.
- To allow both, list both: `ALLOWED_RECIPIENT_DOMAINS=mycompany.com,*.mycompany.com`.

The allowlist applies to `to`, `cc` **and** `bcc`, and to dry runs, so a preview shows that a message would be blocked.

---

## Client configuration

Ready-made snippets are in [`examples/`](examples/). Every stdio client uses the same `mcpServers` shape shown in the [Quick start](#quick-start).

| Client | Where the config goes |
|--------|-----------------------|
| Claude Desktop | `claude_desktop_config.json` (*Settings → Developer → Edit Config*). macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`. |
| Claude Code | `claude mcp add` (see [examples/claude-code.sh](examples/claude-code.sh)) or a project `.mcp.json`. |
| Cursor | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global). |
| Gemini CLI | `~/.gemini/settings.json` (or `.gemini/settings.json` in a project). |
| Antigravity | Its MCP server config (open the MCP settings and use the raw config editor). |

### Remote clients over HTTP (ChatGPT, claude.ai, others)

```bash
MCP_TRANSPORT=http PORT=3000 MCP_AUTH_TOKEN=<long-random-string> npx -y gmail-gdocs-mcp
```

The server listens on `http://127.0.0.1:3000/mcp`. Remote clients need a public **HTTPS** URL, so expose it through a reverse proxy, a cloud deployment, or a tunnel for testing (for example `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`). Register `https://<your-host>/mcp` as a custom connector and send `Authorization: Bearer <MCP_AUTH_TOKEN>`.

Each vendor's connector UI and supported authentication options differ and change over time, so check the current documentation rather than relying on fixed steps here:

- ChatGPT: [Connectors and developer mode](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt)
- claude.ai: [Custom connectors using remote MCP](https://support.anthropic.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)
- Gemini CLI: [MCP servers](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)
- Cursor: [Model Context Protocol](https://docs.cursor.com/context/model-context-protocol)
- Claude Code: [MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)

> [!NOTE]
> v1 authenticates with a static bearer token. Connectors that only support MCP's OAuth-based authorization (no custom header) cannot use it directly yet. MCP OAuth support is planned for v2.

Clients that take a URL plus headers can connect directly; see [examples/cursor-http.json](examples/cursor-http.json) and [examples/gemini-http-settings.json](examples/gemini-http-settings.json).

**Render:** see [DEPLOYMENT.md](DEPLOYMENT.md) for a tested deployment plan.

**Docker** (HTTP mode): authorize once on a machine with a browser, then mount the token directory. See [examples/docker-run.sh](examples/docker-run.sh). On Linux, add `--user "$(id -u):$(id -g)"` so the container can read and refresh your `0600` token file.

The HTTP server is stateless: each POST gets a fresh MCP session, while rate limits are shared across all requests. `GET /healthz` returns `{"status":"ok"}` without authentication.

---

## Tools

Every result contains a human-readable `text` block **and** `structuredContent` matching the tool's declared `outputSchema`. Input schemas are flat JSON Schema (no `oneOf`, `anyOf`, `allOf` or `$ref`), so function-calling implementations such as Gemini's handle them.

### `gmail_send_email`

Send an email from the authorized Gmail account. The tool description tells the model to use it only when the user clearly asked to send an email.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `to` | string[] | yes | 1–50 bare addresses (`name@example.com`). |
| `subject` | string | yes | 1–998 characters, no line breaks. Non-ASCII is RFC 2047-encoded. |
| `body` | string | yes | Up to 500 KB. |
| `body_format` | `"text"` \| `"html"` | no | Default `text`. HTML gets an auto-generated plain-text alternative. |
| `cc`, `bcc` | string[] | no | Up to 50 each. BCC addresses are never echoed back, only counted. |
| `reply_to` | string | no | Sets `Reply-To`. |
| `attachments` | `{filename, mime_type, content_base64}[]` | no | Total decoded size ≤ `MAX_ATTACHMENT_BYTES`. Filenames are stripped of paths. |
| `dry_run` | boolean | no | Validate and build the message and return headers and sizes, but do not send. |

Result:

```json
{ "status": "sent", "message_id": "18f3c…", "thread_id": "18f3c…", "from": "user@example.com",
  "to": ["a@example.com"], "cc": [], "bcc_count": 0, "subject": "Weekly report", "attachment_count": 0 }
```

A dry run returns `"status": "dry_run"` with a `preview` (`headers`, `mime_structure`, `raw_size_bytes`, `body_size_bytes`, `attachment_size_bytes`). Dry runs are not counted against the rate limit.

### `gdocs_append_text`

Append text to the end of an existing Google Doc.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `document` | string | yes | Document ID or `https://docs.google.com/document/d/<ID>/…` URL. A `?tab=` in the URL selects that tab. |
| `text` | string | yes | Up to 200 KB. Each line becomes a paragraph. Trailing newlines are dropped. |
| `paragraph_style` | `NORMAL_TEXT` \| `HEADING_1` \| `HEADING_2` \| `HEADING_3` \| `TITLE` \| `SUBTITLE` | no | Applied to all appended paragraphs. Default `NORMAL_TEXT`. |
| `as_bullets` | boolean | no | Make each appended paragraph a bullet. |
| `add_separator` | boolean | no | Default `true`: start a new paragraph unless the doc already ends with an empty one. |
| `timestamp_prefix` | boolean | no | Prefix with an ISO-8601 timestamp in `TIMEZONE`, e.g. `2026-10-22T14:03:00Z`. |
| `tab_id` | string | no | Tab to append to (e.g. `t.0`). Overrides the URL's tab. Defaults to the first tab. |
| `dry_run` | boolean | no | Resolve the doc and compute the insertion point without writing. |

How it writes: one `documents.batchUpdate`, guarded by `writeControl.requiredRevisionId`. A concurrent edit therefore fails cleanly instead of inserting at the wrong place; the server re-fetches and retries once. In Google Docs, text inserted at the end of a paragraph inherits that paragraph's heading style, bullet and character formatting (bold, links). To prevent that, the server always sets the paragraph style, removes an inherited bullet, and clears inherited character styling on the appended range.

Result:

```json
{ "status": "appended", "document_id": "1AbC…", "title": "Project Log",
  "document_url": "https://docs.google.com/document/d/1AbC…/edit",
  "inserted_start_index": 5821, "inserted_end_index": 5904, "characters_appended": 83, "separator_added": true }
```

Indexes are in UTF-16 code units, as in the Docs API.

### `google_auth_status`

Read-only. Reports `authorized`, `auth_mode`, `email`, the granted `scopes`, `token_expires_at`, and, when something is wrong, `missing_scopes` and `instructions`.

---

## Errors

Errors are tool results with `isError: true`, so the model can see them and recover. They are not protocol exceptions. The text block is one line, and `structuredContent` is:

```json
{ "error": { "code": "PERMISSION_DENIED", "message": "The authenticated account cannot edit document 1AbC…. Share it with user@example.com as an Editor, then retry.", "retryable": false } }
```

| Code | When | Retryable |
|------|------|-----------|
| `INVALID_ARGUMENT` | Bad email, bad doc URL, header-injection attempt, size limits. | no |
| `AUTH_REQUIRED` | No tokens, missing client credentials, or refresh token revoked or expired. | no |
| `PERMISSION_DENIED` | Google 403: doc not shared, scope missing, API not enabled. | no |
| `NOT_FOUND` | Google 404, or an unknown `tab_id`. | no |
| `POLICY_BLOCKED` | Recipient or document not allowlisted, too many recipients, attachments too large, dry run required. | no |
| `RATE_LIMITED` | Local limit or Google 429/quota. Includes `retry_after_seconds` when known. | yes |
| `CONFLICT` | Docs revision conflict that persisted after one retry. | yes |
| `UPSTREAM_ERROR` | Google 5xx or network error after retries. | yes |

Google 429 and 5xx responses are retried internally: at most 3 attempts in total, with exponential backoff and jitter, honouring `Retry-After`. Network errors where the request may already have reached Google are **not** retried for `gmail_send_email`, so an email is never sent twice. Error messages never contain tokens, secrets or message bodies.

Type-level schema violations, such as a number where a string is expected or a missing required field, are rejected by the MCP SDK before the tool runs. They come back as `isError: true` with a text explanation but no `structuredContent`. Every value-level check (addresses, lengths, CR/LF, sizes, IDs) is done by the server and uses the structured format above.

---

## Security recommendations

- **Turn on tool-call confirmation** in your client for `gmail_send_email` (and ideally `gdocs_append_text`). Tool descriptions tell the model to act only on explicit requests, but a server cannot verify user intent. Prompt injection from web pages, documents or emails is a real risk.
- **Set `ALLOWED_RECIPIENT_DOMAINS`** (and `ALLOWED_DOCUMENT_IDS` where practical) as hard backstops. Consider `REQUIRE_DRY_RUN_FIRST=true` for high-stakes accounts.
- **HTTP mode:** always set a long random `MCP_AUTH_TOKEN`. Keep the default `HOST=127.0.0.1` and put TLS in front with a reverse proxy or tunnel. Never expose plain HTTP to the internet. The server validates `Origin` (and `Host` when unauthenticated or when `MCP_ALLOWED_HOSTS` is set) against DNS rebinding, limits request bodies to 15 MB, and never sends a wildcard CORS header.
- **Protect the token file.** It grants send-as-you access. It is written `0600`; don't commit it, and keep `.env` out of version control.
- **Logs** at `info` record the tool name, outcome, latency, Google request IDs, recipient *domains* and document IDs, never addresses or content. `debug` adds more detail, with secrets still redacted.
- Revoke access at any time at <https://myaccount.google.com/permissions>.

---

## Manual testing with MCP Inspector

**stdio:**

```bash
npm run build
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… npx -y @modelcontextprotocol/inspector node dist/index.js
```

In the Inspector UI: *Connect → Tools → List Tools*. You should see exactly three tools. Run `google_auth_status`, then `gmail_send_email` with `dry_run: true`, then a real send to yourself.

**Streamable HTTP:**

```bash
MCP_TRANSPORT=http MCP_AUTH_TOKEN=$(openssl rand -hex 32) node dist/index.js   # note the token
npx -y @modelcontextprotocol/inspector
```

Choose transport **Streamable HTTP**, URL `http://127.0.0.1:3000/mcp`, and add the header `Authorization: Bearer <token>` (in *Authentication*, or as a custom header). Without the header you should get HTTP 401.

Suggested checks (from the acceptance criteria):

1. Send a plain-text email, and an HTML email with one attachment.
2. Append a heading (`paragraph_style: "HEADING_2"`), then a bullet list (`as_bullets: true`) to a test doc. Both land at the end without merging into the previous paragraph.
3. With `ALLOWED_RECIPIENT_DOMAINS=mycompany.com`, send to `x@other.org` and expect `POLICY_BLOCKED`.
4. Use a subject of `Hi\r\nBcc: x@evil.com` and expect `INVALID_ARGUMENT`.
5. Append to a doc you can only view and expect `PERMISSION_DENIED` with sharing instructions.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `AUTH_REQUIRED` … `GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set` | Add both to the client's `env` block. GUI clients do not inherit your shell environment. |
| `AUTH_REQUIRED` … `Run npx -y gmail-gdocs-mcp auth` | Run it with the same env vars. Check that `GOOGLE_TOKEN_PATH` matches between the server and the command. |
| Works for a week, then `AUTH_REQUIRED` | The consent screen is in *Testing* with *External* users. See [the 7-day caveat](#google-cloud-setup). |
| `access_denied` / "app not verified" during auth | Add yourself as a test user, or click *Advanced → Go to app* for an unverified app you own. |
| `PERMISSION_DENIED` … API is not enabled | Enable the Gmail API and Google Docs API in the same project as the OAuth client. Wait a minute. |
| `PERMISSION_DENIED` … missing a required scope | Re-run `auth` and tick every permission. |
| `PERMISSION_DENIED` on a doc | Share the document with the authorized account (shown by `google_auth_status`) as an **Editor**. |
| `NOT_FOUND` on a doc | Check the ID or URL. "Publish to the web" links (`/d/e/…`) can't be edited; use the normal `/edit` URL. |
| HTTP server exits with "requires MCP_AUTH_TOKEN" | Set `MCP_AUTH_TOKEN`, or for local tests only `MCP_ALLOW_UNAUTHENTICATED=true` with `HOST=127.0.0.1`. |
| HTTP 403 "Origin not allowed" | Add the browser origin to `MCP_ALLOWED_ORIGINS`. |
| HTTP 403 "Host not allowed" via a tunnel | Add the public hostname to `MCP_ALLOWED_HOSTS`, or use `ngrok http 3000 --host-header=rewrite`. |
| Client shows "invalid JSON" or the connection drops in stdio mode | Something wrote to stdout. This server never does, so check wrapper scripts. Run with `LOG_LEVEL=debug`; logs appear on stderr (in Claude Desktop: *Settings → Developer → Open Logs Folder*). |

---

## Development

```bash
npm ci
npm run build        # TypeScript → dist/
npm test             # builds, then runs all unit, tool and protocol tests (no network)
npm run typecheck    # src + tests
npm run test:integration   # opt-in, real Google APIs (see below)
```

Integration tests send real email and modify a real document. They need `RUN_INTEGRATION=1` (set by the script), authorized credentials, `TEST_EMAIL_TO`, `TEST_DOC_ID`, and optionally `TEST_READONLY_DOC_ID`.

### Layout

```
src/
  index.ts              CLI entry: args, transport selection, `auth` subcommand
  server.ts             McpServer construction and tool registration
  config.ts             env + CLI parsing and validation (zod)
  logger.ts             stderr-only JSON logger with redaction
  errors.ts             error codes, Google error mapping, retry with backoff
  transports/           stdio.ts, http.ts (bearer auth, Origin/Host checks)
  auth/                 oauth.ts (loopback + PKCE), serviceAccount.ts, tokenStore.ts
  policy/               allowlist.ts, rateLimiter.ts, index.ts (Policy)
  services/             mime.ts (RFC 5322 builder), gmail.ts, gdocs.ts (ID parsing, end-index plan)
  tools/                one file per tool, plus validation and shared result helpers
test/
  unit/  tools/  protocol/  integration/
```

The tool layer depends on small service interfaces (`EmailSender`, `DocsApi`, `AuthProvider`), so tool tests use in-memory fakes and run without network access.

### Not in v1

Reading or searching mail, replying in threads, creating docs, Markdown-to-Docs conversion, "send as" aliases, multiple Google accounts, and MCP OAuth for the HTTP endpoint are all candidates for v2.

## License

MIT
