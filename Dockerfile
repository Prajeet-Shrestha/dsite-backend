FROM node:22-slim

# Install system deps for better-sqlite3 build + curl for healthchecks
RUN apt-get update && apt-get install -y \
    python3 make g++ curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── Install Sui CLI ──
RUN curl -fsSL https://github.com/MystenLabs/sui/releases/download/mainnet-v1.67.3/sui-mainnet-v1.67.3-ubuntu-x86_64.tgz \
    -o /tmp/sui.tgz \
    && tar -xzf /tmp/sui.tgz -C /usr/local/bin/ ./sui \
    && rm /tmp/sui.tgz \
    && chmod +x /usr/local/bin/sui

# ── Install site-builder ──
# Downloaded from Walrus GCS bucket (official distribution)
RUN curl -fsSL "https://storage.googleapis.com/mysten-walrus-binaries/site-builder-mainnet-v2.7.0-ubuntu-x86_64" \
    -o /usr/local/bin/site-builder \
    && chmod +x /usr/local/bin/site-builder

# ── Walrus + Sui configs ──
# sites-config.yaml is needed by the deployer
COPY config/sites-config.yaml /root/.config/walrus/sites-config.yaml

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
