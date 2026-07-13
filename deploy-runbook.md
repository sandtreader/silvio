# Single-VPS deployment runbook

A complete worked example of standing Silvio up on one VPS behind Apache:
the container, TLS, a group hostname, outbound email, the CLI, and seeded
demo data. It complements [deploy.md](deploy.md), which is the reference for
the container itself (environment variables, backups, upgrades) — this doc is
the operational glue around it.

Throughout, replace `example.org` with your own domain, `silvio.example.org`
with the instance's hostname, and every `CHANGE-ME` with a real secret. Run
the shell commands on the server as root (or with `sudo`).

## 0. Prerequisites

- A VPS with **Docker**.
- A reverse proxy terminating TLS. Apache is used below; Caddy and nginx
  equivalents are in [deploy.md](deploy.md#reverse-proxy).
- **DNS** you control. A wildcard record (`*.silvio.example.org`) makes every
  future group hostname free — no new record per group.
- Optional: an **MTA** on the host, if you want outbound email.

## 1. Run the container

```sh
docker run -d --name silvio --restart unless-stopped \
  -p 127.0.0.1:1862:1862 \
  -v silvio-data:/data \
  -e SILVIO_OPERATOR_EMAIL=operator@example.org \
  -e SILVIO_OPERATOR_PASSWORD=CHANGE-ME \
  -e SILVIO_SMTP_URL=smtp://172.17.0.1:25 \
  -e SILVIO_EMAIL_FROM=silvio@example.org \
  ghcr.io/sandtreader/silvio:latest
```

Bind the port to `127.0.0.1` so only the reverse proxy can reach it. The two
`SILVIO_OPERATOR_*` vars bootstrap the first operator account and are ignored
once one exists. The two email vars are optional — see step 4. The full
environment-variable table is in [deploy.md](deploy.md#environment-variables).

Verify it is up (the operator console is host-independent):

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:1862/operator/   # 200
```

## 2. DNS

Point `silvio.example.org` at the server. Add a wildcard
`*.silvio.example.org` too: each group is reached on its own hostname
(`demo.silvio.example.org`, `othergroup.silvio.example.org`, …) and the
wildcard resolves them all without further DNS changes.

## 3. Reverse proxy and TLS (Apache)

Enable the required modules:

```sh
a2enmod proxy_http headers rewrite
```

Create `/etc/apache2/sites-available/silvio.example.org.conf`:

```apache
<VirtualHost *:80>
  ServerName silvio.example.org
  ProxyPreserveHost On
  ProxyPass /.well-known/acme-challenge/ !
  ProxyPass / http://127.0.0.1:1862/
  ProxyPassReverse / http://127.0.0.1:1862/
</VirtualHost>
```

Enable it, then obtain a certificate — certbot clones the vhost to an
`-le-ssl` copy on `:443` and adds the HTTP→HTTPS redirect:

```sh
a2ensite silvio.example.org && systemctl reload apache2
certbot --apache -d silvio.example.org -m operator@example.org --agree-tos --redirect
```

Add one line inside the generated `*-le-ssl.conf` `<VirtualHost>` (certbot
does not add it) and reload:

```apache
  RequestHeader set X-Forwarded-Proto "https"
```

Two settings here are load-bearing:

- **`ProxyPreserveHost On`** — tenancy is chosen by the `Host` header, so it
  must reach the container unchanged.
- **`X-Forwarded-Proto`** — emailed links (verification, password reset) are
  built from it; without it they come out `http://`.

Optionally make the `:80` redirect host-agnostic, so additional group
hostnames need no further redirect edits — replace certbot's generated
`RewriteCond`/`RewriteRule` in the `:80` vhost with:

```apache
  RewriteEngine on
  RewriteCond %{REQUEST_URI} !^/\.well-known/acme-challenge/
  RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [END,NE,R=permanent]
```

## 4. Outbound email (optional)

The container relays through an MTA on the host. Either:

- **exim4** — allow relay from the Docker bridge network, then point the
  container at the bridge gateway:

  ```sh
  # in /etc/exim4/update-exim4.conf.conf
  dc_relay_nets='172.17.0.0/16'
  update-exim4.conf && systemctl reload exim4
  # container: SILVIO_SMTP_URL=smtp://172.17.0.1:25  (as in step 1)
  ```

- **or** run the container with `--network host` and use
  `SILVIO_SMTP_URL=smtp://localhost:25`.

Make sure `SILVIO_EMAIL_FROM` is an address that accepts (or forwards) mail,
so bounces and replies land somewhere real.

## 5. Create a group and serve its hostname

Log in to `https://silvio.example.org/operator/`, provision a group (e.g.
slug `demo`), and attach its hostname (`demo.silvio.example.org`). Then make
the proxy serve that host:

```sh
# add to BOTH the :80 and :443 vhosts, under ServerName:
#   ServerAlias demo.silvio.example.org

# extend the existing certificate to cover the new host (one SAN per host —
# the wildcard is DNS-only, not a wildcard certificate):
certbot certonly --apache --cert-name silvio.example.org --expand \
  -d silvio.example.org -d demo.silvio.example.org

systemctl reload apache2
```

Repeat the `ServerAlias` + `--expand` step for each additional group host.

## 6. Install the CLI (optional)

The CLI is a thin REST client, useful for administration. It needs Node 22.
If the host has none, install the official binary — no package-repo changes:

```sh
cd /tmp
T=$(curl -s https://nodejs.org/dist/latest-v22.x/ \
      | grep -oE 'node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.gz' | head -1)
curl -sO "https://nodejs.org/dist/latest-v22.x/$T"
mkdir -p /opt/node && tar -xzf "$T" -C /opt/node --strip-components=1
ln -sf /opt/node/bin/node /usr/local/bin/node
ln -sf /opt/node/bin/npm  /usr/local/bin/npm
```

Build the CLI from a checkout of this repo, copy the result to the server,
and add a wrapper on `PATH`:

```sh
# on a machine with the repo:
cd cli && npm ci && npm run build          # produces cli/dist/
# copy cli/{dist,node_modules,package.json} to the server, e.g. /opt/silvio-cli/

# on the server:
printf '#!/bin/sh\nexec node /opt/silvio-cli/dist/index.js "$@"\n' > /usr/local/bin/silvio
chmod +x /usr/local/bin/silvio
```

Use it against the loopback port — the `/g/<slug>` path mode selects the
group regardless of the `Host` header:

```sh
silvio op login -s http://localhost:1862 -e operator@example.org -p CHANGE-ME
silvio op groups
silvio login -s http://localhost:1862 -g demo -e member@example.org -p CHANGE-ME
```

## 7. Seed demo data (optional)

`scripts/seed.mjs --group <slug>` fills an existing group with members,
listings, a year of backdated trading history with monthly demurrage, and CMS
content. Backdated history is why the seeder drives the storage layer
directly and runs against the database file rather than over HTTP: the REST
API and CLI always stamp *now*, so a year of history can only be written
directly.

Run it as a one-off container sharing the data volume, with the server
stopped so the two do not contend for the database:

```sh
# copy scripts/seed.mjs to the server, e.g. /opt/silvio/seed.mjs (world-readable)
docker exec silvio npm run backup          # snapshot first
docker stop silvio
docker run --rm \
  -v silvio-data:/data \
  -v /opt/silvio/seed.mjs:/app/scripts/seed.mjs:ro \
  --entrypoint node \
  ghcr.io/sandtreader/silvio:latest \
  /app/scripts/seed.mjs --db /data/silvio.sqlite --group demo --members 10 --months 12
docker start silvio
```

The seeder verifies the ledger hash-chain before it exits, and in `--group`
mode it neutralises the notification emails it generates (to fake demo
addresses) so the restarted server does not try to deliver — and bounce —
them. The mount path matters: placed at `/app/scripts/seed.mjs`, its relative
import of `../server/dist` resolves to the image's built server at
`/app/server/dist`.

## Troubleshooting

- **`docker run` fails with `iptables: No chain/target/match by that name`** —
  a firewall reload (e.g. `ufw`) flushed Docker's iptables chains. Restart the
  daemon to rebuild them: `systemctl restart docker` (containers with a
  restart policy come back automatically).
- **Image pull returns `denied` / `401` for a public image** — clear a stale
  login: `docker logout ghcr.io`.
- **Emailed links come out `http://`** — the proxy is not setting
  `X-Forwarded-Proto` (step 3).
- **A group hostname serves the wrong group or a bare 404** — the `Host`
  header is not reaching the container; check `ProxyPreserveHost On`.

## Backups and upgrades

See [deploy.md](deploy.md#backups) — backups are written into the data volume
and upgrades are a pull-and-recreate with schema migrations applied on boot.
