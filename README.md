# dsite-backend

Decentralized web hosting backend — deploy frontend apps to Walrus Storage (Sui) from GitHub, with Vercel-like UX.

## Deploy on Coolify (Docker Compose)

1. Push to Git — Coolify pulls from your repo
2. Create Docker Compose service in Coolify pointing to `docker-compose.yml`
3. Set secrets in Coolify env vars:
   - `SESSION_SECRET`, `ENCRYPTION_KEY`, `ADMIN_MNEMONICS`
   - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
   - `BUILD_TIMEOUT_MS` (optional, default `600000`)
   - `DEPLOY_TIMEOUT_MS` (optional, default `600000`)
   - `MAX_CONCURRENT_BUILDS` (optional, default `2`)
4. Deploy and verify via IP

## Domain Configuration

### Testing (current — nip.io)

No DNS changes needed. Uses free wildcard DNS via [nip.io](https://nip.io).

In `docker-compose.yml`:
```yaml
- SITE_DOMAIN=207.180.212.180.nip.io
- CLIENT_URL=http://207.180.212.180.nip.io
```

Sites accessible at: `http://<project-name>.207.180.212.180.nip.io:3000`

### Production (swap to beatdown.co)

1. Update `docker-compose.yml`:
```yaml
- SITE_DOMAIN=beatdown.co
- CLIENT_URL=https://beatdown.co
```

2. In Coolify, set domain to `beatdown.co` and `*.beatdown.co`

3. In Cloudflare DNS for `beatdown.co`:

| Type | Name | Content           | Proxy     |
|------|------|--------------------|-----------|
| A    | @    | 207.180.212.180    | Proxied ☁️ |
| A    | *    | 207.180.212.180    | Proxied ☁️ |

4. Re-deploy on Coolify

## ⚠️ Important

The `site-builder` download URL (`storage.googleapis.com/mysten-walrus-binaries/...`) may need verification — if the Docker build fails on that step, check the [Walrus docs](https://docs.walrus.site) for the current Linux binary URL.


## Why the Self-Hosted Portal is Required

Walrus mainnet has **no public portal with wildcard subdomain support**. The site-builder CLI confirms this — after deploying, it only offers two options:

1. **Run a portal locally** (e.g. `http://<base36-id>.localhost:3000`)
2. **Use `wal.app`** — but this requires a **SuiNS name** for each site (purchased at suins.io)

Since dSite is a SaaS where users deploy sites without buying SuiNS names, we **must** run our own portal. This is the `portal` service in `docker-compose.yaml` (image: `mysten/walrus-sites-server-portal`), which the backend proxies via `SITE_DOMAIN` + `PORTAL_URL` env vars.

The proxy in `index.js` maps `<slug>.beatdown.co` → looks up the Walrus object ID → forwards to the portal → serves the site. All site traffic flows through our server, which means bandwidth is a real cost (unlike the "unlimited bandwidth" claim that would apply if a public portal existed).