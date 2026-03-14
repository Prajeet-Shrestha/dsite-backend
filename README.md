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

### Production (swap to emeraldcity.xyz)

1. Update `docker-compose.yml`:
```yaml
- SITE_DOMAIN=emeraldcity.xyz
- CLIENT_URL=https://emeraldcity.xyz
```

2. In Coolify, set domain to `emeraldcity.xyz` and `*.emeraldcity.xyz`

3. In Cloudflare DNS for `emeraldcity.xyz`:

| Type | Name | Content           | Proxy     |
|------|------|--------------------|-----------|
| A    | @    | 207.180.212.180    | Proxied ☁️ |
| A    | *    | 207.180.212.180    | Proxied ☁️ |

4. Re-deploy on Coolify

## ⚠️ Important

The `site-builder` download URL (`storage.googleapis.com/mysten-walrus-binaries/...`) may need verification — if the Docker build fails on that step, check the [Walrus docs](https://docs.walrus.site) for the current Linux binary URL.
