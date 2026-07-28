/**
 * 部署設定的靜態檢查。
 *
 * 稽核在部署層找出的東西有一個共同點：**它們都不會在測試裡出現，
 * 只會在裝機那天出現。** 而裝機那天是暑假，維護者是科目代表老師。
 *
 * 幾個實際找到的：
 *   · Dockerfile 的 COPY 寫成 `… 2>/dev/null || true`（COPY 不是 shell）
 *     → 全新安裝在第三步建置失敗
 *   · WEB_REPLICAS 預設 2 而 ports 是固定主機埠 → 第二個容器起不來
 *   · AI 服務只掛 internal（無對外路由）→ 一填真的 API 金鑰就全失敗
 *   · WAL_ARCHIVE_RETENTION_DAYS 沒有任何一行程式讀取 → 磁碟被撐爆
 *
 * 這一支跑得很快，放進 CI 就不會再犯同一次。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`   \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (e) {
    console.log(`   \x1b[31m✗\x1b[0m ${name}`);
    console.log(`     ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log('\n\x1b[1m── Dockerfile\x1b[0m');

check('COPY 沒有被當成 shell 用', () => {
  for (const f of ['apps/web/Dockerfile', 'apps/ai/Dockerfile', 'deploy/backup/Dockerfile']) {
    if (!existsSync(join(ROOT, f))) continue;
    for (const [i, line] of read(f).split('\n').entries()) {
      const t = line.trim();
      if (!/^COPY\s/i.test(t)) continue;
      assert(
        !/(\|\||&&|2>|>\/dev\/null|\btrue\b)/.test(t),
        `${f}:${i + 1} 的 COPY 含 shell 語法，Docker 會把它當成額外的來源路徑：\n       ${t}`,
      );
    }
  }
});

check('web 映像複製的目錄都存在於 repo 或由建置產生', () => {
  const df = read('apps/web/Dockerfile');
  // apps/web/public 是 Next.js 的慣例目錄，但 repo 裡可能沒有。
  if (df.includes('/app/apps/web/public')) {
    assert(
      existsSync(join(ROOT, 'apps/web/public')) || df.includes('mkdir -p apps/web/public'),
      'Dockerfile 複製 apps/web/public，但它既不在 repo 裡也沒有在 builder 階段建立',
    );
  }
});

console.log('\n\x1b[1m── Compose\x1b[0m');

const compose = (() => {
  try {
    return JSON.parse(
      execFileSync('docker', ['compose', 'config', '--format', 'json'], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return null;
  }
})();

if (!compose) {
  console.log('   · 跳過：這台機器沒有 docker compose');
} else {
  check('發布固定主機埠的服務只有一個副本', () => {
    for (const [name, svc] of Object.entries(compose.services)) {
      const ports = svc.ports ?? [];
      const replicas = svc.deploy?.replicas ?? 1;
      const fixed = ports.some((p) => p.published && !String(p.published).includes('-'));
      assert(
        !fixed || replicas === 1,
        `${name} 發布固定埠 ${ports.map((p) => p.published).join(',')} 卻有 ${replicas} 個副本，第二個會 bind 失敗`,
      );
    }
  });

  check('需要打外部 API 的服務有對外的路由', () => {
    const internalOnly = new Set(
      Object.entries(compose.networks ?? {})
        .filter(([, n]) => n.internal)
        .map(([k]) => k),
    );
    // ai 打模型 API、backup 做異地複製，兩者都必須出得去。
    for (const name of ['ai', 'backup']) {
      const svc = compose.services[name];
      if (!svc) continue;
      const nets = Object.keys(svc.networks ?? {});
      assert(
        nets.some((n) => !internalOnly.has(n)),
        `${name} 只掛在 internal 網路上（${nets.join(',')}），連不到外部 API`,
      );
    }
  });

  check('對外的 web 容器拿不到備份加密金鑰', () => {
    const env = compose.services.web?.environment ?? {};
    for (const k of ['BACKUP_ENCRYPTION_KEY', 'BACKUP_REMOTE_SECRET_KEY', 'GRAFANA_ADMIN_PASSWORD']) {
      assert(!(k in env), `web 容器有 ${k}；行程被打穿時攻擊者會連加密備份一起拿走`);
    }
  });

  check('健康檢查驗的是新鮮度而不是檔案存在', () => {
    for (const [name, svc] of Object.entries(compose.services)) {
      const test = JSON.stringify(svc.healthcheck?.test ?? []);
      if (!/alive/.test(test)) continue;
      assert(
        /date|Date\.now|mtime/.test(test),
        `${name} 的健康檢查只看 ${'/tmp/*-alive'} 存不存在。行程卡死時那個檔還在，狀態永遠是綠的。`,
      );
    }
  });

  check('備份容器掛得到物件儲存與 WAL（且 WAL 可寫）', () => {
    const svc = compose.services.backup;
    if (!svc) return;
    const vols = (svc.volumes ?? []).map((v) => `${v.source}:${v.target}${v.read_only ? ':ro' : ''}`);
    const wal = vols.find((v) => v.includes('/wal_archive'));
    assert(wal, '備份容器沒有掛 WAL 歸檔');
    assert(
      !wal.endsWith(':ro'),
      'WAL 歸檔掛成唯讀，沒有人清得掉；archive_timeout 保證每 15 分鐘一個 16MB 段，一個學期就把磁碟撐爆',
    );
    const nets = Object.keys(svc.networks ?? {});
    assert(nets.length > 0, '備份容器沒有網路，連不到 MinIO');
  });

  check('長時間工作的容器有足夠的關機寬限', () => {
    const svc = compose.services.worker;
    if (!svc) return;
    const grace = svc.stop_grace_period ?? '10s';
    const secs = /(\d+)m/.test(grace)
      ? Number(grace.match(/(\d+)m/)[1]) * 60
      : Number(String(grace).replace(/\D/g, '') || 10);
    assert(
      secs >= 30,
      `worker 的 stop_grace_period 是 ${grace}。一份 200 頁的題本要跑一小時，` +
        '砍太快會讓 BullMQ 判定 stalled 而整份重跑——付兩次錢。',
    );
  });
}

console.log('\n\x1b[1m── 設定與腳本\x1b[0m');

check('.env.example 宣告的每個變數都真的有人讀', () => {
  // 標了「尚未實作」的變數不算——但**必須標**，否則老師會設了
  // 一個以為有效的值（例如 AI 月預算上限）然後在帳單來的時候才發現。
  const lines = read('.env.example').split('\n');
  const declared = [];
  for (const [i, l] of lines.entries()) {
    if (!/^[A-Z][A-Z0-9_]*=/.test(l)) continue;
    const prev = lines.slice(Math.max(0, i - 3), i).join('\n');
    if (/尚未實作/.test(prev)) continue;
    declared.push(l.split('=')[0]);
  }

  // 全文檢索一次，避免對每個變數各跑一次 grep
  const haystack = [
    'docker-compose.yml',
    'apps/web/Dockerfile',
    'apps/ai/Dockerfile',
    'deploy/backup/Dockerfile',
    'deploy/backup/entrypoint.sh',
    'deploy/caddy/Caddyfile',
  ]
    .filter((f) => existsSync(join(ROOT, f)))
    .map(read)
    .join('\n');

  const src = execFileSync(
    'grep',
    ['-rhoE', '[A-Z][A-Z0-9_]{3,}', '--include=*.ts', '--include=*.tsx', '--include=*.mjs',
     '--include=*.py', '--include=*.sh', 'apps', 'tools', 'deploy', 'packages'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  const unused = declared.filter((v) => !haystack.includes(v) && !src.includes(v));
  assert(
    unused.length === 0,
    `這些變數沒有任何程式讀取，設了也不會生效：${unused.join('、')}`,
  );
});

check('VERSION 與最新的 git tag 一致', () => {
  const version = read('VERSION').trim();
  let tag;
  try {
    tag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return; // 還沒有任何 tag
  }
  assert(
    tag.replace(/^v/, '') === version,
    `VERSION 是 ${version} 而最新的 tag 是 ${tag}。` +
      '升級腳本用 VERSION 當映像標籤——不一致的話，新版程式會蓋掉舊版映像，' +
      '回滾時資料庫退回去了而程式碼沒有。',
  );
});

check('遷移不會在有資料的資料庫上中止', () => {
  const dir = join(ROOT, 'packages/db/migrations');
  for (const name of readdirSync(dir)) {
    const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8');
    // 同一份遷移裡剛建出來的表一定是空的，加約束不會中止。
    const fresh = new Set(
      [...sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"([^"]+)"/gi)].map((m) => m[1]),
    );
    // `[^;]` 而不是 `[\s\S]`：跨過分號的話會把「上一句的 VALIDATE」
    // 與「下一句的 ADD CONSTRAINT」串成一個匹配，然後對錯的那一句
    // 檢查 NOT VALID。
    for (const m of sql.matchAll(/ALTER TABLE\s+"([^"]+)"[^;]{0,80}?ADD CONSTRAINT\s+"([^"]+)"\s+CHECK/gi)) {
      if (fresh.has(m[1])) continue;
      // 從 ADD CONSTRAINT 起到分號為止就是這一句
      const stmt = sql.slice(m.index).split(';')[0];
      assert(
        /NOT VALID/i.test(stmt),
        `${name} 對既有的 ${m[1]} 直接 ADD CONSTRAINT ${m[2]} CHECK。` +
          '既有資料若有一列不符合，整份遷移中止、prisma migrate deploy 標成 failed 卡住升級。' +
          '請改用 NOT VALID 再 VALIDATE。',
      );
    }
  }
});

check('shell 腳本語法正確', () => {
  const scripts = [];
  const walk = (rel) => {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(rel, e.name));
      else if (e.name.endsWith('.sh')) scripts.push(join(rel, e.name));
    }
  };
  walk('deploy');
  walk('tools');
  for (const s of scripts) {
    execFileSync('bash', ['-n', s], { cwd: ROOT, stdio: 'pipe' });
  }
});

console.log(`\n${passed}/${passed + failed} 通過\n`);
process.exit(failed ? 1 : 0);
