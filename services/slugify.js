// ── Slug generation and validation for custom domain subdomains ──

const RESERVED = new Set([
  'api', 'www', 'admin', 'mail', 'app', 'dashboard',
  'static', 'assets', 'cdn', 'ws', 'ftp', 'smtp',
]);

/**
 * Generate a URL-safe slug from a project name.
 * Converts spaces/underscores/dots to hyphens, strips invalid chars.
 */
function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')     // spaces, underscores, dots → hyphens
    .replace(/[^a-z0-9-]/g, '')   // strip non-alphanumeric
    .replace(/-+/g, '-')          // collapse multiple hyphens
    .replace(/^-|-$/g, '')        // trim leading/trailing hyphens
    .slice(0, 63);
}

/**
 * Validate a slug for subdomain use.
 * Returns error string or null if valid.
 */
function validateSlug(slug) {
  if (!slug || slug.length < 2) return 'Name too short for a valid URL';
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) return 'Invalid name format';
  if (RESERVED.has(slug)) return `"${slug}" is a reserved name`;
  return null;
}

module.exports = { generateSlug, validateSlug, RESERVED };
