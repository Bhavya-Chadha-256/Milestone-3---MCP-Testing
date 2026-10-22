#!/usr/bin/env sh
# 1. Authorize once on a machine with a browser (writes ~/.config/gmail-gdocs-mcp/token.json):
#      GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npx -y gmail-gdocs-mcp auth
# 2. Build and run the HTTP image with the token directory mounted:
docker build -t gmail-gdocs-mcp .
docker run --rm -p 127.0.0.1:3000:3000 \
  -e GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com \
  -e GOOGLE_CLIENT_SECRET=xxxxx \
  -e MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
  -e ALLOWED_RECIPIENT_DOMAINS=mycompany.com \
  -v "$HOME/.config/gmail-gdocs-mcp:/data" \
  gmail-gdocs-mcp
