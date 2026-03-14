// ── GitHub API Service ──

/**
 * Custom error for GitHub auth failures (401/403).
 * Signals that the user's token is invalid and they need to re-authenticate.
 */
class GitHubAuthError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubAuthError';
    this.status = status;
  }
}

// Helper to check response and throw GitHubAuthError on 401/403
function checkAuth(res, context) {
  if (res.status === 401 || res.status === 403) {
    throw new GitHubAuthError(
      `GitHub ${context} failed: ${res.status} — please reconnect your account`,
      res.status
    );
  }
}

/**
 * Exchange OAuth code for access token.
 * Gap #4: MUST set Accept: application/json — otherwise GitHub returns form-urlencoded.
 */
async function exchangeCodeForToken(code) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(data.error_description || data.error);
  }
  return data.access_token;
}

/**
 * Fetch authenticated user profile from GitHub.
 */
async function getUser(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub /user failed: ${res.status}`);
  return res.json();
}

/**
 * Fetch ALL user repos (up to 300).
 * Gap #8: Need sort, affiliation, per_page for useful results.
 * Gap #9: Fetch all pages so server-side search works correctly.
 */
async function getUserRepos(token) {
  const allRepos = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(
      `https://api.github.com/user/repos?sort=updated&direction=desc&per_page=100&affiliation=owner,collaborator,organization_member&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
      }
    );
    if (!res.ok) throw new Error(`GitHub /user/repos failed: ${res.status}`);
    const repos = await res.json();
    allRepos.push(...repos);
    if (repos.length < 100) break; // No more pages
  }
  return allRepos;
}

/**
 * Fetch branches for a specific repo.
 */
async function getRepoBranches(token, owner, repo) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    }
  );
  if (!res.ok) throw new Error(`GitHub branches failed: ${res.status}`);
  return res.json();
}

/**
 * Read a file from a repo via GitHub Contents API.
 * Gap #13: Content comes back base64-encoded — must decode.
 * Returns parsed JSON or null if file doesn't exist.
 */
async function getRepoFile(token, owner, repo, filePath) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub contents failed: ${res.status}`);
  const data = await res.json();
  const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
  return JSON.parse(decoded);
}

/**
 * Fetch the latest commit on a branch.
 * Returns { sha, message } for the HEAD commit.
 */
async function getLatestCommit(token, owner, repo, branch) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    }
  );
  checkAuth(res, 'commits');
  if (!res.ok) throw new Error(`GitHub commits failed: ${res.status}`);
  const commits = await res.json();
  if (!commits.length) throw new Error(`No commits found on branch ${branch}`);
  return {
    sha: commits[0].sha,
    message: (commits[0].commit?.message || '').split('\n')[0].slice(0, 200),
  };
}

/**
 * Create a commit status (pending/success/failure/error).
 * Best-effort — callers should wrap in try/catch (U3).
 */
async function createCommitStatus(token, owner, repo, sha, state, description, targetUrl) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/statuses/${sha}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state, // 'pending' | 'success' | 'failure' | 'error'
        description: (description || '').slice(0, 140),
        target_url: targetUrl || undefined,
        context: 'dsite/deploy',
      }),
    }
  );
  if (!res.ok) {
    console.warn(`createCommitStatus failed: ${res.status}`);
  }
}

module.exports = {
  GitHubAuthError,
  exchangeCodeForToken,
  getUser,
  getUserRepos,
  getRepoBranches,
  getRepoFile,
  getLatestCommit,
  createCommitStatus,
};
