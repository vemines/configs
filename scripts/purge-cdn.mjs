import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

const REPO = 'vemines/configs';
const BRANCH = 'main';
const DEFAULT_DELAY_MS = 1000; // 1s per file to prevent CDN throttling

// Top-level internal directories to exclude from CDN purging
const EXCLUDED_DIRS = new Set([
  '.git',
  '.github',
  '.cache',
  'scripts',
  'node_modules',
  '.vscode',
  '.idea',
  '.husky',
]);

// Comprehensive whitelist of allowed public web & configuration file extensions
const ALLOWED_EXTENSIONS = new Set([
  // Data & Config
  '.json', '.json5', '.txt', '.csv', '.tsv', '.xml', '.yaml', '.yml', '.toml', '.ini',
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif', '.bmp', '.tiff',
  // Media & Video
  '.mp4', '.webm', '.mp3', '.wav', '.ogg',
  // Documents & Office
  '.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt',
  // Web Fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // Git's well-known empty tree hash
const DEFAULT_CACHE_FILE = '.cache/last_purged_sha';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Checks if a commit SHA actually exists in the local Git repository
 */
function isValidGitCommit(sha) {
  if (!sha || typeof sha !== 'string' || /^0+$/.test(sha.trim())) return false;
  try {
    execSync(`git cat-file -e ${sha.trim()}^{commit}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads cached last purged SHA from file if present
 */
async function getCachedPurgedSha(cachePath = DEFAULT_CACHE_FILE) {
  try {
    const content = await fs.readFile(cachePath, 'utf-8');
    const sha = content.trim();
    if (isValidGitCommit(sha)) {
      return sha;
    }
  } catch {
    // Cache file does not exist yet
  }
  return null;
}

/**
 * Saves current HEAD commit SHA to cache file
 */
async function savePurgedSha(cachePath = DEFAULT_CACHE_FILE) {
  try {
    const headSha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, headSha, 'utf-8');
    console.log(`💾 Saved state: last purged SHA → ${headSha.slice(0, 7)}`);
  } catch (err) {
    console.warn(`⚠️ Could not save purge cache file: ${err.message}`);
  }
}

/**
 * Checks if a file path is eligible for CDN purge using comprehensive whitelist
 */
function isEligibleFile(filePath) {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/');

  // 1. Exclude top-level internal directories
  if (parts.length > 1 && EXCLUDED_DIRS.has(parts[0])) {
    return false;
  }
  if (parts.length === 1 && EXCLUDED_DIRS.has(parts[0])) {
    return false;
  }

  const basename = path.basename(normalized);

  // 2. Exclude macOS AppleDouble resource-fork junk (._filename)
  if (basename.startsWith('._')) {
    return false;
  }

  // 3. Match against allowed extensions whitelist
  const ext = path.extname(normalized).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

/**
 * Gets modified / created files from Git status and diffs with comprehensive edge-case handling
 */
async function getGitChangedFiles() {
  const changed = new Set();

  // 1. Check uncommitted changes (working tree & staged)
  try {
    const statusOut = execSync('git status --porcelain', { encoding: 'utf-8' });
    for (const line of statusOut.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Skip deleted files (status starts with ' D' or 'D ')
      const statusCode = line.substring(0, 2);
      if (statusCode.includes('D')) continue;

      const rawPath = trimmed.substring(2).trim().replace(/^"|"$/g, '');
      if (rawPath) {
        changed.add(rawPath.replace(/\\/g, '/'));
      }
    }
  } catch {
    // Ignore git status error
  }

  // 2. Determine base commit to diff against
  const cacheFile = process.env.CACHE_FILE || DEFAULT_CACHE_FILE;
  const cachedSha = await getCachedPurgedSha(cacheFile);
  const envBaseSha = process.env.BASE_SHA;
  let diffCmd = '';

  if (cachedSha && isValidGitCommit(cachedSha)) {
    // Priority 1: Use cached SHA from previous successful purge run (bulletproof against force-pushes)
    console.log(`📌 Using cached last purged commit: ${cachedSha.slice(0, 7)}`);
    diffCmd = `git diff --name-only --diff-filter=d ${cachedSha} HEAD`;
  } else if (isValidGitCommit(envBaseSha)) {
    // Priority 2: Use push range base commit provided by GitHub Actions (github.event.before)
    console.log(`📌 Using push base commit: ${envBaseSha.slice(0, 7)}`);
    diffCmd = `git diff --name-only --diff-filter=d ${envBaseSha} HEAD`;
  } else if (isValidGitCommit('HEAD~1')) {
    // Priority 3: Fallback to previous commit
    if (envBaseSha) {
      console.warn(`⚠️ BASE_SHA "${envBaseSha.slice(0, 7)}" not found in Git history (force-push?). Falling back to HEAD~1.`);
    }
    diffCmd = 'git diff --name-only --diff-filter=d HEAD~1 HEAD';
  } else {
    // Priority 4: First commit in repository / initial push (diff against empty tree)
    console.log('📌 Initial repository push detected. Diffing against empty tree.');
    diffCmd = `git diff --name-only --diff-filter=d ${EMPTY_TREE_SHA} HEAD`;
  }

  try {
    const diffOut = execSync(diffCmd, { encoding: 'utf-8' });
    for (const line of diffOut.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) changed.add(trimmed.replace(/\\/g, '/'));
    }
  } catch {
    // Ultimate Fallback: diff against empty tree
    try {
      const diffFallback = execSync(`git diff --name-only --diff-filter=d ${EMPTY_TREE_SHA} HEAD`, { encoding: 'utf-8' });
      for (const line of diffFallback.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) changed.add(trimmed.replace(/\\/g, '/'));
      }
    } catch {
      // Ignore
    }
  }

  return Array.from(changed);
}

/**
 * Recursively scans whole repository for all eligible files
 */
async function getAllProjectFiles(rootDir = '.') {
  const files = [];

  async function scan(currentDir) {
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
        const isTopLevel = !relPath.includes('/');

        if (entry.isDirectory()) {
          // Only exclude top-level internal directories
          if (!(isTopLevel && EXCLUDED_DIRS.has(entry.name))) {
            await scan(fullPath);
          }
        } else if (entry.isFile()) {
          if (isEligibleFile(relPath)) {
            files.push(relPath);
          }
        }
      }
    } catch {
      // Directory access error
    }
  }

  await scan(rootDir);
  return files;
}

/**
 * Normalizes a relative path to standard jsDelivr purge URL
 */
function normalizeToPurgeUrl(filePath) {
  const cleanPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `https://purge.jsdelivr.net/gh/${REPO}@${BRANCH}/${cleanPath}`;
}

/**
 * Purges a single target URL via GET request
 */
async function purgeSingleUrl(targetPath) {
  const purgeUrl = normalizeToPurgeUrl(targetPath);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(purgeUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'jsDelivr-Cache-Purger/Node.js',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return { target: targetPath, status: 'ERROR', message: `HTTP ${res.status} ${res.statusText}` };
    }

    const data = await res.json();
    const paths = data.paths || {};

    let isThrottled = false;
    let throttlingReset = 0;

    for (const p of Object.values(paths)) {
      if (p && typeof p === 'object') {
        if (p.throttled) {
          isThrottled = true;
          throttlingReset = p.throttlingReset || 0;
        }
      }
    }

    if (isThrottled) {
      const min = (throttlingReset / 60).toFixed(1);
      return { target: targetPath, status: 'THROTTLED', message: `Cooldown ~${min}m (${throttlingReset}s remaining)` };
    }

    return { target: targetPath, status: 'SUCCESS', message: 'OK' };
  } catch (err) {
    return { target: targetPath, status: 'ERROR', message: err.message };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isAll = args.includes('--all');
  const delayArg = args.find((a) => a.startsWith('--delay='));
  const delayMs = delayArg ? parseInt(delayArg.split('=')[1], 10) || DEFAULT_DELAY_MS : DEFAULT_DELAY_MS;
  const directFiles = args.filter((a) => !a.startsWith('--'));

  let targets = [];

  if (directFiles.length > 0) {
    // 1. User specified specific file paths
    targets = directFiles.map((f) => f.replace(/\\/g, '/')).filter(isEligibleFile);
    console.log(`🎯 Purging ${targets.length} specified file(s)...`);
  } else if (isAll) {
    // 2. Full scan across entire project
    console.log(`🔍 Scanning all public project files across repository...`);
    targets = await getAllProjectFiles('.');
  } else {
    // 3. Smart Git-diff mode (Default)
    console.log(`⚡ Git Change Detection Mode: Finding modified files in repository...`);
    const changed = await getGitChangedFiles();
    
    // Filter only eligible project files that currently exist on disk
    targets = [];
    for (const file of changed) {
      if (isEligibleFile(file)) {
        try {
          await fs.access(file);
          targets.push(file);
        } catch {
          // File was deleted, skip purging
        }
      }
    }

    if (targets.length === 0) {
      console.log('✨ No recent Git changes detected in project files.');
      console.log('💡 Tip: Use `node scripts/purge-cdn.mjs --all` to force purge all repository files.');
      const cacheFile = process.env.CACHE_FILE || DEFAULT_CACHE_FILE;
      await savePurgedSha(cacheFile);
      return;
    }
  }

  console.log(`🚀 Starting purge for ${targets.length} file(s) (Delay: ${delayMs}ms/file)...\n`);

  const results = [];
  for (let i = 0; i < targets.length; i++) {
    const file = targets[i];
    const res = await purgeSingleUrl(file);
    results.push(res);

    if (res.status === 'SUCCESS') {
      console.log(`  [${i + 1}/${targets.length}] [\x1b[32mSUCCESS\x1b[0m] ${res.target}`);
    } else if (res.status === 'THROTTLED') {
      console.log(`  [${i + 1}/${targets.length}] [\x1b[33mTHROTTLED\x1b[0m] ${res.target} -> ${res.message}`);
    } else {
      console.log(`  [${i + 1}/${targets.length}] [\x1b[31m${res.status}\x1b[0m] ${res.target} -> ${res.message}`);
    }

    // Rate-limit delay between requests (skip delay on last item)
    if (i < targets.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  const stats = {
    SUCCESS: results.filter((r) => r.status === 'SUCCESS').length,
    THROTTLED: results.filter((r) => r.status === 'THROTTLED').length,
    ERROR: results.filter((r) => r.status === 'ERROR').length,
  };

  console.log('\n' + '='.repeat(60));
  console.log(`📊 Purge Summary: ${stats.SUCCESS} Succeeded | ${stats.THROTTLED} Throttled | ${stats.ERROR} Errors`);
  if (stats.THROTTLED > 0) {
    console.log('💡 Note: jsDelivr enforces a cooldown (~1h) per file. CDN still updates after TTL.');
  }
  console.log('='.repeat(60));

  // Save successful purge state to cache file
  if (stats.ERROR === 0 && !directFiles.length) {
    const cacheFile = process.env.CACHE_FILE || DEFAULT_CACHE_FILE;
    await savePurgedSha(cacheFile);
  }
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
