#!/usr/bin/env sh
# Claude Code, stdio (local):
claude mcp add gmail-gdocs \
  -e GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com \
  -e GOOGLE_CLIENT_SECRET=xxxxx \
  -e ALLOWED_RECIPIENT_DOMAINS=mycompany.com \
  -- npx -y gmail-gdocs-mcp

# Claude Code, Streamable HTTP (server started separately with MCP_TRANSPORT=http):
# claude mcp add --transport http gmail-gdocs http://127.0.0.1:3000/mcp \
#   --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
