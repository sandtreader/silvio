# Silvio: build the UIs and server, then a slim runtime image serving both.
# Packages build in dependency order — ui/shared is consumed by ui/member and
# ui/admin via file:../shared, so it must be installed and built first.

# ---- build stage -----------------------------------------------------------
FROM node:22-slim AS build

WORKDIR /build

COPY ui/shared/ ui/shared/
RUN cd ui/shared && npm ci && npm run build

COPY ui/member/ ui/member/
RUN cd ui/member && npm ci && npm run build

COPY ui/admin/ ui/admin/
RUN cd ui/admin && npm ci && npm run build

COPY ui/operator/ ui/operator/
RUN cd ui/operator && npm ci && npm run build

# Build with dev deps, then reinstall production-only for the runtime copy.
COPY server/ server/
RUN cd server && npm ci && npm run build && npm ci --omit=dev

# ---- runtime stage ---------------------------------------------------------
FROM node:22-slim

ENV NODE_ENV=production \
    SILVIO_DB=/data/silvio.sqlite \
    SILVIO_BACKUP_DIR=/data/backups \
    SILVIO_MEMBER_UI=/app/ui/member/dist \
    SILVIO_ADMIN_UI=/app/ui/admin/dist \
    SILVIO_OPERATOR_UI=/app/ui/operator/dist

WORKDIR /app/server

COPY --from=build /build/server/package.json /build/server/package-lock.json ./
COPY --from=build /build/server/node_modules ./node_modules
COPY --from=build /build/server/dist ./dist
COPY --from=build /build/ui/member/dist /app/ui/member/dist
COPY --from=build /build/ui/admin/dist /app/ui/admin/dist
COPY --from=build /build/ui/operator/dist /app/ui/operator/dist

# /data holds the database and backups; owned by the unprivileged user so a
# named volume inherits writable permissions.
RUN mkdir -p /data/backups && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 1862

# Any HTTP response counts as healthy — the group root is a cheap 404 when no
# group matches the Host header.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SILVIO_PORT??1862)+'/',{method:'HEAD'}).then(()=>process.exit(0),()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
