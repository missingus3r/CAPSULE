FROM node:22-alpine AS build

WORKDIR /app
COPY tsconfig.base.json ./tsconfig.base.json
COPY apps/relay/package.json apps/relay/package-lock.json ./apps/relay/
WORKDIR /app/apps/relay
RUN npm ci --no-audit --no-fund

COPY apps/relay/tsconfig.json ./tsconfig.json
COPY apps/relay/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    CAPSULE_HOST=0.0.0.0 \
    CAPSULE_PORT=8787 \
    CAPSULE_STORAGE_DIR=/data

WORKDIR /app
COPY --from=build --chown=node:node /app/apps/relay/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/relay/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/relay/dist ./dist

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
