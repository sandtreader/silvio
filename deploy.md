# Deploying Silvio

Silvio's deployment target is a minimal VPS: one Docker container, one
volume. Images are published to GHCR by CI on every push to `main`
(`.github/workflows/docker.yml`).

## What you get

- One container running the server, which serves the REST API, the
  brochure site, and the built member (`/app/`) and admin (`/admin/`)
  UIs on port 1862.
- One volume mounted at `/data`, holding the SQLite database
  (`/data/silvio.sqlite`) and its rotated backups (`/data/backups`).

Everything else — TLS, DNS for each group's hostname — sits in front
(see the reverse proxy section).

## Quick start

```sh
docker run -d --name silvio \
  --restart unless-stopped \
  -p 1862:1862 \
  -v silvio-data:/data \
  -e SILVIO_OPERATOR_EMAIL=you@example.org \
  -e SILVIO_OPERATOR_PASSWORD=change-me \
  ghcr.io/sandtreader/silvio:latest
```

On first boot the server creates the operator account from the two env
vars (idempotent — they are ignored once an operator exists, so they can
stay in place or be removed). Then open the **operator console** at
`/operator/` (any hostname the container answers on — it is
host-independent), log in with those credentials, and provision and
manage groups from there (#21). The same operations exist as plain API
calls (`POST /api/v1/operator/login`, `/api/v1/operator/groups`) if you
prefer curl.

Prefer a named volume as above; the container runs as the unprivileged
`node` user (uid 1000), so a bind mount (`-v /srv/silvio:/data`) must be
writable by uid 1000 (`chown 1000:1000 /srv/silvio`).

## Environment variables

| Variable | Image default | Meaning |
| --- | --- | --- |
| `SILVIO_DB` | `/data/silvio.sqlite` | SQLite database path |
| `SILVIO_PORT` | `1862` | Listen port |
| `SILVIO_HOST` | `0.0.0.0` | Listen address |
| `SILVIO_OPERATOR_EMAIL` / `SILVIO_OPERATOR_PASSWORD` | — | First-boot operator bootstrap; without them (and no TTY) the server warns and runs with no operator |
| `SILVIO_SMTP_URL` | — | Outbound email: nodemailer URL, e.g. `smtp://user:pass@mail.example.org:587` (query params pass transport options). Unset, emails queue but are not sent |
| `SILVIO_EMAIL_FROM` | — | From address for outbound email (required together with `SILVIO_SMTP_URL`) |
| `SILVIO_BACKUP_DIR` | `/data/backups` | Backup directory; unset it to disable backups (don't) |
| `SILVIO_MEMBER_UI` / `SILVIO_ADMIN_UI` / `SILVIO_OPERATOR_UI` | `/app/ui/member/dist`, `/app/ui/admin/dist`, `/app/ui/operator/dist` | Built UI directories baked into the image; override only to serve different builds |
| `SILVIO_CONFIG` | `./silvio.json` | Optional JSON config file; the default path may be absent, an explicit one must exist |
| `SILVIO_LOG_LEVEL` | `info` | Level for the structured (pino JSON) logging |

Every knob can instead be set in the config file — a flat JSON object with
camelCase keys (`db`, `port`, `host`, `logLevel`, `operatorEmail`,
`operatorPassword`, `smtpUrl`, `emailFrom`, `backupDir`, `memberUi`,
`adminUi`, `operatorUi`); env vars override the file, the file overrides
defaults.

## Reverse proxy

Terminate TLS in front of the container. Two things matter:

- **The `Host` header must pass through unchanged** — tenancy is
  host-based, so the group a request lands on is chosen by hostname.
  Point every group's hostname at the same proxy.
- **Set `x-forwarded-proto`** — emailed links (password reset, email
  verification) are built from the request's host and this header;
  without it they come out as `http://`.

Caddy does both by default:

```
letsgroup.example.org, othergroup.example.org {
    reverse_proxy localhost:1862
}
```

nginx equivalent:

```nginx
server {
    listen 443 ssl;
    server_name letsgroup.example.org othergroup.example.org;
    location / {
        proxy_pass http://localhost:1862;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Backups

With `SILVIO_BACKUP_DIR` set (the image default), the server writes one
SQLite online-backup copy per UTC day to
`/data/backups/silvio-YYYY-MM-DD.sqlite`, checked hourly. Each copy is
written via a temp file and `PRAGMA integrity_check`ed before it lands,
so a bad copy never takes a daily name. Rotation keeps the newest 7
dailies plus the newest 4 Monday-dated files.

That protects against application-level damage, not a dead VPS. For
off-site backups, copy the backups directory somewhere else on a cron —
the daily files are complete, consistent snapshots, safe to copy at any
time (unlike the live database):

```sh
rsync -a /var/lib/docker/volumes/silvio-data/_data/backups/ backup-host:silvio-backups/
```

or point restic/borg at the same directory.

If losing up to a day is not acceptable, run a
[Litestream](https://litestream.io) sidecar sharing the `/data` volume
to replicate the live database's WAL continuously to S3-compatible
storage. It works well with SQLite in WAL mode (which Silvio uses), but
it is an optional extra, not part of this image.

## Restore

1. Stop the container: `docker stop silvio`.
2. Replace the database with the chosen backup file, e.g.
   `cp /data/backups/silvio-2026-07-01.sqlite /data/silvio.sqlite`
   (inside the volume; remove any leftover `silvio.sqlite-wal` /
   `silvio.sqlite-shm` files).
3. Start it again: `docker start silvio`.

The scheduled ledger verification re-checks every group's hash chain on
the first scheduler tick after boot, so a corrupt or truncated restore
shows up loudly in the logs rather than silently.

## Manual snapshot before an upgrade

```sh
docker exec silvio npm run backup
```

writes today's integrity-checked copy into `/data/backups` (a no-op if
today's daily already exists — the running server and the manual run
share the same directory and naming).

## Upgrading

```sh
docker pull ghcr.io/sandtreader/silvio:latest
docker exec silvio npm run backup   # pre-upgrade snapshot
docker stop silvio && docker rm silvio
docker run -d --name silvio ...     # same flags as before, new image
```

Schema migrations run automatically on boot. To pin a version, use the
commit-SHA tag CI pushes alongside `latest`.

## CORS

There is none, deliberately. Everything — API, brochure, member and
admin UIs — is served same-origin from the one container behind one
hostname per group, so no CORS configuration exists or is needed. If a
separately-hosted UI origin ever appears, CORS support becomes a server
feature, not a proxy hack.
