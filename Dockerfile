# Build stage
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

# Runtime: express + static build. The L4 itself runs in the separate xgas-l3 Fly app (Nitro).
FROM node:20-bookworm-slim AS runner
WORKDIR /app
COPY package*.json ./
RUN npm install --production --legacy-peer-deps
COPY --from=builder /app/dist ./dist
COPY server.js ./
# Link-preview cards: server/og renders them (satori + @resvg/resvg-wasm, pure JS/WASM, installed above) with the
# bundled fonts in assets/fonts.
COPY server ./server
COPY assets ./assets
# server.js imports the connector's tool registry AND serves it at /mcp; only mcp/src is needed
# at runtime (its deps, viem and the MCP SDK, are root dependencies).
COPY mcp/src ./mcp/src
# ...and its package.json: the connector reports its own published version from it.
COPY mcp/package.json ./mcp/package.json
COPY src/contracts/l4-deployment.json ./src/contracts/l4-deployment.json
EXPOSE 3000
ENV PORT=3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
