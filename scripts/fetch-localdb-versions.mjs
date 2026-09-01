import fs from 'node:fs/promises';
import path from 'node:path';

// Helper parse version
function parseParts(v) {
  return v.replace(/^[^\d]*/, '').replace(/-.*$/, '').split('.').map(Number);
}

function compareDesc(a, b) {
  const pA = parseParts(a);
  const pB = parseParts(b);
  for (let i = 0; i < Math.max(pA.length, pB.length); i++) {
    const diff = (pB[i] || 0) - (pA[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// 1. Fetch PostgreSQL (Dynamic API for supported majors)
async function getPostgres() {
  try {
    const res = await fetch('https://www.postgresql.org/versions.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const active = data
      .filter((d) => d.supported || Number(d.major) >= 13)
      .map((d) => {
        const ver = `${d.major}.${d.latestMinor}`;
        return {
          version: ver,
          branch: String(d.major),
          downloadUrl: `https://get.enterprisedb.com/postgresql/postgresql-${ver}-1-windows-x64-binaries.zip`,
          cliSubpath: 'bin/psql.exe',
          serverSubpath: 'bin/postgres.exe',
        };
      })
      .sort((a, b) => compareDesc(a.version, b.version));

    return active;
  } catch (err) {
    console.warn('⚠️ [Postgres] Fallback to default list:', err.message);
    return [
      { version: '18.6', branch: '18', downloadUrl: 'https://get.enterprisedb.com/postgresql/postgresql-18.6-1-windows-x64-binaries.zip', cliSubpath: 'bin/psql.exe', serverSubpath: 'bin/postgres.exe' },
      { version: '17.11', branch: '17', downloadUrl: 'https://get.enterprisedb.com/postgresql/postgresql-17.11-1-windows-x64-binaries.zip', cliSubpath: 'bin/psql.exe', serverSubpath: 'bin/postgres.exe' },
      { version: '16.15', branch: '16', downloadUrl: 'https://get.enterprisedb.com/postgresql/postgresql-16.15-1-windows-x64-binaries.zip', cliSubpath: 'bin/psql.exe', serverSubpath: 'bin/postgres.exe' },
      { version: '15.19', branch: '15', downloadUrl: 'https://get.enterprisedb.com/postgresql/postgresql-15.19-1-windows-x64-binaries.zip', cliSubpath: 'bin/psql.exe', serverSubpath: 'bin/postgres.exe' },
      { version: '14.24', branch: '14', downloadUrl: 'https://get.enterprisedb.com/postgresql/postgresql-14.24-1-windows-x64-binaries.zip', cliSubpath: 'bin/psql.exe', serverSubpath: 'bin/postgres.exe' },
      { version: '13.18', branch: '13', downloadUrl: 'https://get.enterprisedb.com/postgresql/postgresql-13.18-1-windows-x64-binaries.zip', cliSubpath: 'bin/psql.exe', serverSubpath: 'bin/postgres.exe' },
    ];
  }
}

// 2. Fetch Redis (Major branch grouping: 8.x, 7.x, 6.x + Legacy 5.0.14.1)
async function getRedis() {
  const legacy5 = {
    version: '5.0.14.1',
    branch: '5.0',
    downloadUrl: 'https://github.com/tporadowski/redis/releases/download/v5.0.14.1/Redis-x64-5.0.14.1.zip',
    cliSubpath: 'bin/redis-cli.exe',
    serverSubpath: 'bin/redis-server.exe',
  };

  try {
    const headers = { 'User-Agent': 'LocalDB-Config-Updater' };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch('https://api.github.com/repos/redis-windows/redis-windows/releases?per_page=30', { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const releases = await res.json();

    const majorMap = new Map();
    for (const rel of releases) {
      const ver = rel.tag_name;
      if (!ver || ver.includes('rc') || ver.includes('beta')) continue;
      const parts = parseParts(ver);
      const majorKey = String(parts[0]); // Group by distinct Major (8.x, 7.x, 6.x)
      if (!majorMap.has(majorKey)) {
        const asset = (rel.assets || []).find((a) => a.name?.endsWith('-Windows-x64-msys2.zip')) ||
                      (rel.assets || []).find((a) => a.name?.includes('Windows-x64') && a.name?.endsWith('.zip'));
        const downloadUrl = asset ? asset.browser_download_url : `https://github.com/redis-windows/redis-windows/releases/download/${ver}/Redis-${ver}-Windows-x64-msys2.zip`;

        majorMap.set(majorKey, {
          version: ver,
          branch: `${parts[0]}.${parts[1]}`,
          downloadUrl,
          cliSubpath: 'bin/redis-cli.exe',
          serverSubpath: 'bin/redis-server.exe',
        });
      }
    }

    const list = Array.from(majorMap.values()).sort((a, b) => compareDesc(a.version, b.version));
    list.push(legacy5);
    return list;
  } catch (err) {
    console.warn('⚠️ [Redis] Fallback to default list:', err.message);
    return [
      { version: '8.10.1', branch: '8.10', downloadUrl: 'https://github.com/redis-windows/redis-windows/releases/download/8.10.1/Redis-8.10.1-Windows-x64-msys2.zip', cliSubpath: 'bin/redis-cli.exe', serverSubpath: 'bin/redis-server.exe' },
      { version: '7.4.1', branch: '7.4', downloadUrl: 'https://github.com/redis-windows/redis-windows/releases/download/7.4.1/Redis-7.4.1-Windows-x64-msys2.zip', cliSubpath: 'bin/redis-cli.exe', serverSubpath: 'bin/redis-server.exe' },
      { version: '6.2.14', branch: '6.2', downloadUrl: 'https://github.com/redis-windows/redis-windows/releases/download/6.2.14/Redis-6.2.14-Windows-x64-msys2.zip', cliSubpath: 'bin/redis-cli.exe', serverSubpath: 'bin/redis-server.exe' },
      legacy5,
    ];
  }
}

// 3. Get MongoDB (8.0, 7.0, 6.0, 5.0 and Legacy 4.4 for non-AVX CPUs)
async function getMongo() {
  const cliUrl = 'https://downloads.mongodb.com/compass/mongosh-2.3.8-win32-x64.zip';
  return [
    {
      version: '8.0.4',
      branch: '8.0',
      serverUrl: 'https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-8.0.4.zip',
      cliUrl,
      serverSubpath: 'bin/mongod.exe',
      cliSubpath: 'bin/mongosh.exe',
    },
    {
      version: '7.0.14',
      branch: '7.0',
      serverUrl: 'https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-7.0.14.zip',
      cliUrl,
      serverSubpath: 'bin/mongod.exe',
      cliSubpath: 'bin/mongosh.exe',
    },
    {
      version: '6.0.19',
      branch: '6.0',
      serverUrl: 'https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-6.0.19.zip',
      cliUrl,
      serverSubpath: 'bin/mongod.exe',
      cliSubpath: 'bin/mongosh.exe',
    },
    {
      version: '5.0.28',
      branch: '5.0',
      serverUrl: 'https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-5.0.28.zip',
      cliUrl,
      serverSubpath: 'bin/mongod.exe',
      cliSubpath: 'bin/mongosh.exe',
    },
    {
      version: '4.4.29',
      branch: '4.4 (Legacy)',
      serverUrl: 'https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-4.4.29.zip',
      cliUrl,
      serverSubpath: 'bin/mongod.exe',
      cliSubpath: 'bin/mongosh.exe',
    },
  ];
}

// 4. Get MySQL (8.4 LTS, 8.0 General, and 5.7 Legacy)
async function getMySQL() {
  return [
    {
      version: '8.4.3',
      branch: '8.4 (LTS)',
      downloadUrl: 'https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-8.4.3-winx64.zip',
      serverSubpath: 'bin/mysqld.exe',
      cliSubpath: 'bin/mysql.exe',
    },
    {
      version: '8.0.39',
      branch: '8.0',
      downloadUrl: 'https://cdn.mysql.com/Downloads/MySQL-8.0/mysql-8.0.39-winx64.zip',
      serverSubpath: 'bin/mysqld.exe',
      cliSubpath: 'bin/mysql.exe',
    },
    {
      version: '5.7.44',
      branch: '5.7 (Legacy)',
      downloadUrl: 'https://downloads.mysql.com/archives/get/p/23/file/mysql-5.7.44-winx64.zip',
      serverSubpath: 'bin/mysqld.exe',
      cliSubpath: 'bin/mysql.exe',
    },
  ];
}

// 5. Get SQLite (Stable branches)
async function getSQLite() {
  return [
    {
      version: '3.46.1',
      branch: '3.46',
      downloadUrl: 'https://www.sqlite.org/2024/sqlite-tools-win-x64-3460100.zip',
      serverSubpath: 'bin/sqlite3.exe',
      cliSubpath: 'bin/sqlite3.exe',
    },
    {
      version: '3.45.3',
      branch: '3.45',
      downloadUrl: 'https://www.sqlite.org/2024/sqlite-tools-win-x64-3450300.zip',
      serverSubpath: 'bin/sqlite3.exe',
      cliSubpath: 'bin/sqlite3.exe',
    },
    {
      version: '3.44.2',
      branch: '3.44',
      downloadUrl: 'https://www.sqlite.org/2023/sqlite-tools-win-x64-3440200.zip',
      serverSubpath: 'bin/sqlite3.exe',
      cliSubpath: 'bin/sqlite3.exe',
    },
  ];
}

async function main() {
  console.log('🔄 Đang tổng hợp Major & Legacy versions cho LocalDB...');

  const [postgres, redis, mongodb, mysql, sqlite] = await Promise.all([
    getPostgres(),
    getRedis(),
    getMongo(),
    getMySQL(),
    getSQLite(),
  ]);

  const output = {
    schemaVersion: '1.0.0',
    lastUpdated: new Date().toISOString(),
    engines: {
      mongodb,
      redis,
      postgresql: postgres,
      mysql,
      sqlite,
    },
  };

  const targetDir = path.resolve('localDB');
  await fs.mkdir(targetDir, { recursive: true });
  const targetFile = path.join(targetDir, 'versions.json');

  await fs.writeFile(targetFile, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`✅ Đã xuất thành công: ${targetFile}`);
}

main().catch((err) => {
  console.error('❌ Lỗi:', err);
  process.exit(1);
});
