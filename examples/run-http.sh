#!/usr/bin/env sh
# Start the Streamable HTTP server for remote clients (ChatGPT, claude.ai, MCP Inspector).
# Expose https://<your-host>/mcp through a reverse proxy or tunnel; never plain HTTP on the internet.
export MCP_TRANSPORT=http
export PORT=3000
export MCP_AUTH_TOKEN="${MCP_AUTH_TOKEN:-$(openssl rand -hex 32)}"
echo "MCP_AUTH_TOKEN=$MCP_AUTH_TOKEN" >&2
exec npx -y gmail-gdocs-mcp
