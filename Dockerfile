FROM node:22-slim

# Install system deps for better-sqlite3 build + curl for healthchecks
RUN apt-get update && apt-get install -y \
    python3 make g++ curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Enable corepack for pnpm/yarn support (user repos may use any package manager)
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install common build tools globally so user repos don't fail on missing CLIs
# (tsc, sass, tailwindcss, webpack, etc.)
RUN npm install -g typescript sass tailwindcss webpack webpack-cli vite

# ── Install Sui CLI ──
RUN curl -fsSL https://github.com/MystenLabs/sui/releases/download/mainnet-v1.67.3/sui-mainnet-v1.67.3-ubuntu-x86_64.tgz \
    -o /tmp/sui.tgz \
    && tar -xzf /tmp/sui.tgz -C /usr/local/bin/ ./sui \
    && rm /tmp/sui.tgz \
    && chmod +x /usr/local/bin/sui

# ── Install site-builder ──
# Downloaded from Walrus GCS bucket (official distribution)
RUN curl -fsSL "https://storage.googleapis.com/mysten-walrus-binaries/site-builder-mainnet-latest-ubuntu-x86_64" \
    -o /usr/local/bin/site-builder \
    && chmod +x /usr/local/bin/site-builder

# ── Install Walrus CLI ──
# Required by site-builder to upload blobs to the Walrus network
RUN curl -fsSL "https://storage.googleapis.com/mysten-walrus-binaries/walrus-mainnet-latest-ubuntu-x86_64" \
    -o /usr/local/bin/walrus \
    && chmod +x /usr/local/bin/walrus

# ── Walrus + Sui configs ──
# sites-config.yaml is needed by the site-builder deployer
COPY config/sites-config.yaml /root/.config/walrus/sites-config.yaml
# client_config.yaml is needed by the walrus CLI binary (blob uploads)
COPY config/walrus-client-config.yaml /root/.config/walrus/client_config.yaml

# Sui wallet config will be generated at runtime from ADMIN_MNEMONICS
# via deployer.setupWallet()

WORKDIR /app

# Install deps
COPY package.json package-lock.json* ./
RUN npm ci --production

# Copy source
COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
