# HTTP-mode image. Authorize once on a machine with a browser (`npx -y gmail-gdocs-mcp auth`),
# then mount the token file:  -v ~/.config/gmail-gdocs-mcp:/data
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-alpine
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=3000 \
    GOOGLE_TOKEN_PATH=/data/token.json
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
# MCP_AUTH_TOKEN must be supplied at runtime; the server refuses to start without it.
CMD ["node", "dist/index.js"]
