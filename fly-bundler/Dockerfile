# xgas-bundler: Pimlico Alto (ERC-4337 bundler) for the xGas L4, chain 466302.
# Built from npm (@pimlico/alto pinned in package-lock.json) so the image runs exactly what test/fork-e2e.sh tested.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY alto.config.json entrypoint.sh ./
COPY scripts ./scripts

USER node
EXPOSE 4337
CMD ["sh", "/app/entrypoint.sh"]
