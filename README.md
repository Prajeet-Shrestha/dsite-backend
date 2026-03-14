# dsite-backend

To deploy on Coolify:
Push to Git — Coolify pulls from your repo
Create Docker Compose service in Coolify pointing to docker-compose.yml
Set secrets in Coolify env vars:
SESSION_SECRET, ENCRYPTION_KEY, ADMIN_MNEMONICS
GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
Set domain to emeraldcity.xyz and *.emeraldcity.xyz
Cloudflare DNS: Add wildcard * A record → server IP (proxied)
IMPORTANT

The site-builder download URL (storage.googleapis.com/mysten-walrus-binaries/...) may need verification — if the Docker build fails on that step, check the Walrus docs for the current Linux binary URL.

