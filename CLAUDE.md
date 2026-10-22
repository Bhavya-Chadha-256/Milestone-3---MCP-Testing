# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## What this is

`gmail-gdocs-mcp`: a client-agnostic MCP server (TypeScript, Node 20+, ESM) with three tools: `gmail_send_email`, `gdocs_append_text` and `google_auth_status`. It serves stdio (local clients) and Streamable HTTP (remote clients). User docs are in [README.md](README.md). Deployment plan, **current deployment status** and runbook are in [DEPLOYMENT.md](DEPLOYMENT.md); read its "Current status" table first when resuming deployment work.

## Commands

```bash
npm ci                    # install (lockfile pinned)
npm run build             # tsc → dist/
npm test                  # builds first (pretest), then vitest. No network needed.
npm run typecheck         # src + tests
npm run auth              # OAuth loopback + PKCE; writes ~/.config/gmail-gdocs-mcp/token.json (0600)
npm run test:integration  # opt-in, REAL Gmail/Docs side effects; needs TEST_EMAIL_TO, TEST_DOC_ID
npm run start:http        # HTTP mode locally (needs MCP_AUTH_TOKEN)
```

Render build command: `npm ci --include=dev && npm run build`. Without `--include=dev`, TypeScript is skipped when `NODE_ENV=production`.

## Architecture (keep the layers separate)

`index.ts` (CLI) → `server.ts` (McpServer + registration) → `tools/` (validation, result shaping) → `policy/` (allowlists, rate limits, dry-run-first) → `services/` (`mime.ts`, `gmail.ts`, `gdocs.ts`) → `auth/` (OAuth, service account, token store). `errors.ts` maps Google errors to the 8 codes in §11 and holds `withRetry`. Tools depend only on small interfaces (`EmailSender`, `DocsApi`, `AuthProvider`). Tests use fakes from `test/helpers/fakes.ts`.

## Invariants: don't break these

- **stdout is protocol-only in stdio mode.** Log only via `logger.ts` (stderr JSON). `dotenv` must stay `quiet: true`. `test/protocol/stdio.test.ts` spawns the built binary and checks every stdout line.
- **Tool schemas must stay client-safe:** snake_case names; flat zod shapes that compile to JSON Schema with no `oneOf`/`anyOf`/`allOf`/`$ref`; a `.describe()` on every input field. No `.nullable()` (it emits `anyOf`); use `.optional()`. `test/tools/toolsList.test.ts` enforces this.
- **Zod schemas carry only types, enums and defaults; value rules live in `tools/validation.ts`.** Failures must return structured `INVALID_ARGUMENT` results (`isError` plus `structuredContent.error`). SDK-level zod failures can't carry `structuredContent`.
- **Every result has a text block and `structuredContent`** matching `outputSchema`. Errors are tool results, never thrown protocol errors.
- **Never log or return secrets, tokens, full addresses or bodies at `info`.** Log recipient domains and doc IDs only. BCC addresses are only ever counted.
- **No vendor-specific behaviour**; never branch on the connected client.
- `gmail_send_email` must not retry ambiguous network errors (double-send risk). `gdocs_append_text` uses `requiredRevisionId` and retries a conflict once.

## Non-obvious behaviour (learned the hard way)

- **Docs inheritance:** text inserted at a paragraph's end inherits its heading style, bullet, indentation and character style (bold, links). So `buildAppendPlan` always sets `namedStyleType`, resets text style, and on removing an inherited bullet also resets `indentStart`/`indentFirstLine`. All of this was verified live against Google Docs.
- Docs indices are UTF-16 code units (JS `.length` matches). Characters the Docs API strips are removed before indices are computed.
- ICU prints UTC as `GMT` or `GMT+00:00` depending on version; `formatTimestamp` normalizes both to `Z`.
- `fetch()` silently drops a custom `Host` header; Host-spoofing tests use `node:http`.
- In this machine's zsh, `status` is a read-only variable; don't use it as a shell variable name.
- A server started as `node dist/index.js` from another directory doesn't match `pkill -f <path>`. Stop test servers by port: `lsof -tiTCP:<port> -sTCP:LISTEN | xargs kill`.
- On Render the token secret file (`/etc/secrets/token.json`) is read-only. The server keeps refreshed tokens in memory and warns once; that's expected.

## Security rules for this repo

- **The GitHub repo is public.** Never commit `.env`, `.env.*` (except `.env.example`) or `token.json`; all are git-ignored. Before pushing, check `git status`, and scan staged content for real credential values (not just patterns: test fixtures intentionally contain fake `ya29.`/`GOCSPX-` strings).
- Keep personal data (real email addresses, doc IDs, project IDs) out of committed files. Commits use the repo-local GitHub noreply identity already configured in `.git/config`.
- `.env` is for local runs; `.env.render` is the local, git-ignored copy of the Render environment for bulk paste. Don't merge them (see DEPLOYMENT.md).
- Real side effects (sending email, editing docs) need the user's explicit go-ahead. Prefer `dry_run: true` when verifying.

## Conventions

- Match the existing style: small functions, guard clauses, JSDoc only where intent isn't obvious, `ToolError` for every expected failure.
- Add tests with every behaviour change; keep `npm test` network-free.
- Commit messages end with the co-author trailer used in history.
