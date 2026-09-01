import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

const REPO = 'vemines/configs';
const BRANCH = 'main';
const TARGET_DIRS = ['images', 'vemines.cc'];
const DEFAULT_DELAY_MS = 1000; // 1 second delay per file to prevent CDN throttling

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gets modified / created files from Git status and last commit
 */
function getGitChangedFiles() {
  const changed = new Set();

  // 1. Uncommitted changes (working tree & staged)
  try {
    const statusOut = execSync('git status --porcelain', { encoding: 'utf-8' });
    for (const line of statusOut.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const rawPath = trimmed.substring(3).trim().replace(/^"|"$/g, '');
      if (rawPath) changed.add(rawPath.replace(/\\/g, '/'));
    }
  } catch {
    // Ignore git status error
  }

  // 2. Changes in the latest commit (HEAD~1 -> HEAD)
  try {
    const diffOut = execSync('git diff --name-only HEAD~1 HEAD', { encoding: 'utf-8' });
    for (const line of diffOut.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) changed.add(trimmed.replace(/\\/g, '/'));
    }
  } catch {
    // If only 1 commit exists or git diff fails, try HEAD
    try {
      const diffHead = execSync('git diff --name-only HEAD', { encoding: 'utf-8' });
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
 * Recursively gets all files in a directory
 */
async function getAllFilesInDirs(dirs) {
  const files = [];

  async function scan(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) {
            await scan(fullPath);
          }
        } else if (entry.isFile()) {
          if (!entry.name.startsWith('.')) {
            files.push(path.relative(process.cwd(), fullPath).replace(/\\/g, '/'));
          }
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  for (const dir of dirs) {
    await scan(dir);
  }

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
    targets = directFiles.map((f) => f.replace(/\\/g, '/'));
    console.log(`🎯 Purging ${targets.length} specified file(s)...`);
  } else if (isAll) {
    // 2. User requested full scan with --all
    console.log(`🔍 Scanning all files in [${TARGET_DIRS.join(', ')}]...`);
    targets = await getAllFilesInDirs(TARGET_DIRS);
  } else {
    // 3. Smart Git-diff mode (Default)
    console.log(`⚡ Git Change Detection Mode: Finding modified files in [${TARGET_DIRS.join(', ')}]...`);
    const changed = getGitChangedFiles();
    
    // Filter only files belonging to target directories
    targets = changed.filter((f) => TARGET_DIRS.some((dir) => f.startsWith(`${dir}/`) || f === dir));

    if (targets.length === 0) {
      console.log('✨ No recent Git changes detected in images/ or vemines.cc/.');
      console.log('💡 Tip: Use `node scripts/purge-cdn.mjs --all` to force purge all files.');
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
