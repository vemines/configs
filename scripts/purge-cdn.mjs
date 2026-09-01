import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

const REPO = 'vemines/configs';
const BRANCH = 'main';
const DEFAULT_DELAY_MS = 1000; // 1s per file to prevent CDN throttling
const EXCLUDED_DIRS = new Set(['.git', '.github', 'scripts', 'node_modules']);
const EXCLUDED_EXTENSIONS = new Set(['.md', '.gitignore', '.gitattributes']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Checks if a file path is eligible for CDN purge (not in internal/excluded folders)
 */
function isEligibleFile(filePath) {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/');

  // Exclude top-level internal directories
  if (parts.length > 0 && EXCLUDED_DIRS.has(parts[0])) {
    return false;
  }

  // Exclude hidden files or non-content files
  const ext = path.extname(normalized).toLowerCase();
  if (EXCLUDED_EXTENSIONS.has(ext)) {
    return false;
  }

  return true;
}

/**
 * Gets modified / created files from Git status and diffs
 */
function getGitChangedFiles() {
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

  // 2. Check changes in commit(s)
  // If in GitHub Actions push event, use base commit comparison if available
  const baseSha = process.env.BASE_SHA || process.env.GITHUB_BASE_REF;
  let diffCmd = 'git diff --name-only --diff-filter=d HEAD~1 HEAD';

  if (baseSha && baseSha !== '0000000000000000000000000000000000000000') {
    diffCmd = `git diff --name-only --diff-filter=d ${baseSha} HEAD`;
  }

  try {
    const diffOut = execSync(diffCmd, { encoding: 'utf-8' });
    for (const line of diffOut.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) changed.add(trimmed.replace(/\\/g, '/'));
    }
  } catch {
    // Fallback: compare against HEAD
    try {
      const diffHead = execSync('git diff --name-only --diff-filter=d HEAD', { encoding: 'utf-8' });
      for (const line of diffHead.split('\n')) {
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

        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
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
    const changed = getGitChangedFiles();
    
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
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
