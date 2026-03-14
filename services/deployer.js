// ── Deployer Service ──
// Wraps site-builder CLI to deploy static sites to Walrus
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { dataDir } = require('../db');

// ── Config ──
const WALRUS_CONTEXT = process.env.WALRUS_CONTEXT || 'testnet';
const WALRUS_EPOCHS = parseInt(process.env.WALRUS_EPOCHS) || 30;
const SITE_BUILDER = process.env.SITE_BUILDER_PATH || 'site-builder';
const SITES_CONFIG = path.join(os.homedir(), '.config', 'walrus', 'sites-config.yaml');

// Default Sui config (used by sui CLI — writes JSON aliases)
const SUI_CONFIG = path.join(os.homedir(), '.sui', 'sui_config');

// Separate config for site-builder (YAML aliases)
const SB_CONFIG = path.join(dataDir, 'site-builder-config');

// Admin mnemonic for sanitization
const ADMIN_MNEMONIC = process.env.ADMIN_MNEMONICS || '';

// Stored wallet address after import
let walletAddress = null;

/**
 * Sanitize deployer output
 */
function sanitize(text) {
  let clean = text;
  if (ADMIN_MNEMONIC) {
    clean = clean.replaceAll(ADMIN_MNEMONIC, '[REDACTED_MNEMONIC]');
  }
  return clean;
}

/**
 * Run a sui CLI command (uses default ~/.sui/sui_config).
 */
function suiSync(args, timeout = 30000) {
  return spawnSync('sui', args, { encoding: 'utf8', timeout });
}

/**
 * Fix corrupted sui.aliases JSON.
 * sui keytool import appends entries but corrupts the JSON (duplicate brackets).
 */
function cleanAliasesJson() {
  const aliasPath = path.join(SUI_CONFIG, 'sui.aliases');
  try {
    if (!fs.existsSync(aliasPath)) return;
    const raw = fs.readFileSync(aliasPath, 'utf8').trim();
    // If already valid JSON, no fix needed
    try { JSON.parse(raw); return; } catch {}
    // sui keytool import corrupts by appending junk after the first valid ]
    // Strategy: find all valid {alias, public_key_base64} objects via regex
    const entries = [];
    const re = /"alias"\s*:\s*"([^"]+)"\s*,\s*"public_key_base64"\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      // Deduplicate by public_key_base64
      if (!entries.find(e => e.public_key_base64 === m[2])) {
        entries.push({ alias: m[1], public_key_base64: m[2] });
      }
    }
    const cleaned = JSON.stringify(entries, null, 2);
    JSON.parse(cleaned); // Validate
    fs.writeFileSync(aliasPath, cleaned);
  } catch {}
}

/**
 * Create a site-builder compatible copy of the Sui config.
 * Copies client.yaml + keystore, converts sui.aliases JSON→YAML.
 */
function createSiteBuilderConfig() {
  fs.rmSync(SB_CONFIG, { recursive: true, force: true });
  fs.mkdirSync(SB_CONFIG, { recursive: true });

  // Copy client.yaml, rewriting keystore path to point to our copy
  const clientYaml = fs.readFileSync(path.join(SUI_CONFIG, 'client.yaml'), 'utf8');
  const fixedYaml = clientYaml.replace(
    /File:.*sui\.keystore/,
    `File: ${path.join(SB_CONFIG, 'sui.keystore')}`
  );
  fs.writeFileSync(path.join(SB_CONFIG, 'client.yaml'), fixedYaml);

  // Copy keystore as-is
  fs.copyFileSync(
    path.join(SUI_CONFIG, 'sui.keystore'),
    path.join(SB_CONFIG, 'sui.keystore')
  );

  // Copy aliases as JSON (site-builder expects JSON format)
  const aliasPath = path.join(SUI_CONFIG, 'sui.aliases');
  if (fs.existsSync(aliasPath)) {
    let content = fs.readFileSync(aliasPath, 'utf8').trim();
    try {
      // Validate JSON, clean corrupt trailing chars if needed
      try { JSON.parse(content); } catch {
        content = content.replace(/\]\s*\}[\s\S]*$/, ']');
        JSON.parse(content);
      }
      fs.writeFileSync(path.join(SB_CONFIG, 'sui.aliases'), content);
      console.log(`✓ Created site-builder config (${JSON.parse(content).length} keys)`);
    } catch (err) {
      console.warn('Aliases copy failed:', err.message);
      fs.copyFileSync(aliasPath, path.join(SB_CONFIG, 'sui.aliases'));
    }
  }
}

/**
 * Set up the admin wallet at startup.
 * Uses sui CLI with default config (JSON aliases).
 * Then creates a separate YAML config for site-builder.
 */
async function setupWallet() {
  const mnemonic = process.env.ADMIN_MNEMONICS;
  if (!mnemonic) {
    throw new Error('ADMIN_MNEMONICS not set — cannot deploy to Walrus');
  }

  console.log('Setting up Walrus deployer wallet...');

  // 0. Fix any corrupted aliases from previous runs
  cleanAliasesJson();

  // 1. Non-interactive init (creates client.yaml if missing)
  spawnSync('sui', ['client', '-y'], {
    encoding: 'utf8', timeout: 30000, input: '',
  });

  // 2. Add network environment
  const network = WALRUS_CONTEXT; // 'testnet' or 'mainnet'
  const rpcUrls = {
    testnet: 'https://fullnode.testnet.sui.io:443',
    mainnet: 'https://fullnode.mainnet.sui.io:443',
  };
  const envCheck = suiSync(['client', 'envs']);
  if (!envCheck.stdout?.includes(network)) {
    suiSync(['client', 'new-env', '--alias', network,
      '--rpc', rpcUrls[network] || rpcUrls.testnet]);
  }

  // 3. Switch to network
  suiSync(['client', 'switch', '--env', network]);

  // 4. Import mnemonic (idempotent)
  const importResult = spawnSync('sui', [
    'keytool', 'import', mnemonic, 'ed25519',
  ], { encoding: 'utf8', timeout: 15000 });

  // Fix: sui keytool import corrupts JSON (appends extra brackets)
  cleanAliasesJson();

  // Parse address from output
  const output = (importResult.stdout || '') + (importResult.stderr || '');
  const addrMatch = output.match(/0x[a-fA-F0-9]{64}/);
  if (addrMatch) {
    walletAddress = addrMatch[0];
    suiSync(['client', 'switch', '--address', walletAddress]);
    console.log(`✓ Wallet address: ${walletAddress}`);
  } else {
    const activeResult = suiSync(['client', 'active-address']);
    if (activeResult.stdout?.trim()) {
      walletAddress = activeResult.stdout.trim();
      console.log(`✓ Active wallet: ${walletAddress}`);
    } else {
      console.warn('⚠ Could not detect wallet address');
    }
  }

  // 5. Verify balance
  const balanceResult = suiSync(['client', 'balance']);
  if (balanceResult.stdout) {
    console.log('Wallet balance:');
    console.log(balanceResult.stdout.trim());
  }

  // 6. Create site-builder compatible config (JSON → YAML)
  createSiteBuilderConfig();

  console.log('✓ Deployer wallet ready');
}

/**
 * Get current SUI and WAL balances.
 */
function getBalances() {
  let sui = 0, wal = 0;
  try {
    const gasResult = suiSync(['client', 'gas', '--json']);
    if (gasResult.stdout) {
      const coins = JSON.parse(gasResult.stdout);
      sui = coins.reduce((s, c) => s + (c.mistBalance || 0), 0) / 1e9;
    }
  } catch {}
  try {
    const balResult = suiSync(['client', 'balance']);
    if (balResult.stdout) {
      const m = balResult.stdout.match(/WAL\s+Token\s+(\d+)/);
      if (m) wal = parseInt(m[1]) / 1e9;
    }
  } catch {}
  return { sui, wal };
}

/**
 * Deploy a built site to Walrus.
 */
async function run(project, outputDir, emitLog) {
  // Snapshot balance BEFORE
  const before = getBalances();
  emitLog(`Wallet: ${walletAddress || 'unknown'}`);
  if (before.sui === 0) {
    emitLog('⚠ Warning: No SUI balance detected — deploy may fail');
  }

  let deployError = null;
  let objectId = null;
  let url = null;

  try {
    // Build site-builder command
    const args = [
      `--context=${WALRUS_CONTEXT}`,
      '--config', SITES_CONFIG,
      '--wallet', path.join(SB_CONFIG, 'client.yaml'),
      'deploy',
      '--epochs', String(WALRUS_EPOCHS),
    ];

    if (project.walrus_object_id) {
      args.push('--object-id', project.walrus_object_id);
      emitLog(`Updating existing site: ${project.walrus_object_id}`);
    } else {
      emitLog('Creating new Walrus site...');
    }

    args.push(outputDir);
    emitLog(`Running: ${SITE_BUILDER} ${args.join(' ')}`);

    // Run site-builder
    const result = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      const child = spawn(SITE_BUILDER, args, {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        for (const line of text.split('\n').filter(Boolean)) {
          emitLog(sanitize(line));
        }
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr += text;
        for (const line of text.split('\n').filter(Boolean)) {
          emitLog(sanitize(line));
        }
      });

      child.on('close', (code) => {
        child.stdout?.destroy();
        child.stderr?.destroy();

        if (code !== 0) {
          const combined = stdout + stderr;
          if (combined.includes('InsufficientGas') || combined.includes('insufficient')) {
            reject(new Error('Deploy failed: insufficient SUI for gas. Fund the admin wallet.'));
          } else if (combined.includes('WAL') && combined.includes('balance')) {
            reject(new Error('Deploy failed: insufficient WAL tokens. Run: walrus get-wal --context testnet'));
          } else {
            reject(new Error(`site-builder exited with code ${code}: ${sanitize(combined.slice(-500))}`));
          }
          return;
        }
        resolve({ stdout, stderr });
      });

      child.on('error', (err) => {
        if (err.code === 'ENOENT') {
          reject(new Error(`site-builder not found at "${SITE_BUILDER}". Run: ./scripts/setup-walrus.sh`));
        } else {
          reject(err);
        }
      });
    });

    // Parse object ID from output
    const combined = result.stdout + result.stderr;
    const objectIdMatch = combined.match(/(?:New|Updated)\s+site\s+object\s+ID:\s*(0x[a-fA-F0-9]+)/i);
    objectId = objectIdMatch?.[1];

    // Fallback: ws-resources.json
    if (!objectId) {
      const wsResourcesPath = path.join(outputDir, 'ws-resources.json');
      if (fs.existsSync(wsResourcesPath)) {
        try {
          const resources = JSON.parse(fs.readFileSync(wsResourcesPath, 'utf8'));
          objectId = resources.objectId || resources.object_id;
          if (objectId) emitLog(`Object ID from ws-resources.json: ${objectId}`);
        } catch (parseErr) {
          emitLog(`Warning: failed to parse ws-resources.json: ${parseErr.message}`);
        }
      }
    }

    if (!objectId) {
      emitLog('Warning: could not extract object ID from site-builder output');
      objectId = 'unknown';
    }

    // Build site URL — prefer custom domain if configured
    if (process.env.SITE_DOMAIN && project.slug) {
      const isLocal = process.env.SITE_DOMAIN === 'localhost';
      const scheme = isLocal ? 'http' : 'https';
      const port = isLocal ? `:${process.env.PORT || 3000}` : '';
      url = `${scheme}://${project.slug}.${process.env.SITE_DOMAIN}${port}`;
    } else {
      // Parse URL from site-builder output (it knows the correct portal domain)
      const urlMatch = combined.match(/https?:\/\/\S+\.(?:walrus\.site|wal\.app)\S*/i);
      if (urlMatch) {
        url = urlMatch[0].replace(/\s+$/, '');
      } else {
        const siteDomain = WALRUS_CONTEXT === 'mainnet' ? 'walrus.site' : `${WALRUS_CONTEXT}-sites.walrus.site`;
        url = `https://${objectId}.${siteDomain}`;
      }
    }
    emitLog(`Site URL: ${url}`);
  } catch (err) {
    deployError = err;
  }

  // Snapshot balance AFTER (always runs — captures gas cost on failure too)
  const after = getBalances();
  const suiCost = Math.max(0, +(before.sui - after.sui).toFixed(9));
  const walCost = deployError ? 0 : Math.max(0, +(before.wal - after.wal).toFixed(9));

  if (suiCost > 0 || walCost > 0) {
    emitLog(`💰 Cost: ${suiCost.toFixed(4)} SUI${walCost > 0 ? `, ${walCost.toFixed(2)} WAL` : ''}`);
  }

  // Re-throw with cost attached, or return success
  if (deployError) {
    deployError.suiCost = suiCost;
    throw deployError;
  }

  return { objectId, url, suiCost, walCost };
}

module.exports = { setupWallet, run };
