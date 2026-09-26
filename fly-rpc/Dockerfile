# xgas-rpc: failover JSON-RPC proxy for Robinhood Chain (4663). No npm dependencies, so nothing to install.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY package.json server.mjs ./

USER node
EXPOSE 8545
CMD ["node", "server.mjs"]
