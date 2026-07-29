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
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
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

// ── Dockerfile 的 COPY 解析 ────────────────────────────────────────
//
// 下面三項檢查共用這一份解析。它把每一行 COPY 拆成
// 「映像裡的位置 ← 建置脈絡裡的位置」，因為裝機當天最貴的那一類
// 錯誤就出在這個對應上：**檔案在 repo 裡好好的，但沒有被搬進映像，
// 或者搬進去之後相對位置變了。** 那種錯誤本機跑測試永遠看不到。

/** 建置脈絡（相對 ROOT）。與 docker-compose.yml 的 build.context 一致。 */
const DOCKERFILES = {
  'apps/web/Dockerfile': '.',
  'apps/ai/Dockerfile': 'apps/ai',
  'deploy/backup/Dockerfile': 'deploy/backup',
};

/**
 * lib/env.ts 裡沒有 default／optional 的欄位＝必填。
 *
 * 這一份清單有兩個地方要對上，而且**兩個地方漏掉的症狀完全不同**：
 *   建置期漏 → `next build` 讀路由設定時載入 lib/env.ts，exit 78，
 *              docker compose build 直接失敗
 *   執行期漏 → 容器起得來、readyz 也綠，第一個用到它的請求把行程帶走
 */
function requiredWebEnv() {
  const src = read('apps/web/lib/env.ts');
  const body = src.slice(src.indexOf('z.object({'));
  const keys = [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => ({
    name: m[1],
    at: m.index,
  }));
  return keys
    .filter(({ at }, i) => {
      const entry = body.slice(at, keys[i + 1]?.at ?? body.length);
      return !/\.default\(|\.optional\(/.test(entry);
    })
    .map((k) => k.name);
}

/** 某個 Dockerfile 階段裡宣告過的環境變數（ENV／ARG，只認 KEY=value 寫法）。 */
function stageEnvVars(dockerfile, matchStage) {
  const text = read(dockerfile).replace(/\\\n/g, ' ');
  const stages = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    if (/^FROM\s/i.test(t)) {
      cur = { body: [], vars: new Set() };
      stages.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.body.push(t);
    if (!/^(ENV|ARG)\s/i.test(t)) continue;
    for (const m of t.replace(/^(ENV|ARG)\s+/i, '').matchAll(/([A-Z][A-Z0-9_]*)=/g)) {
      cur.vars.add(m[1]);
    }
  }
  return stages.find((s) => matchStage(s.body.join('\n')))?.vars ?? null;
}

function parseCopies(dockerfile) {
  const out = [];
  let workdir = '/';
  let stage = 0;
  // 續行（行尾反斜線）先接起來，否則多行的 COPY 會被拆散。
  const text = read(dockerfile).replace(/\\\n/g, ' ');
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    // 每個 FROM 是一個新階段，WORKDIR 也跟著重來。多階段建置裡
    // 只有**最後一個階段**的內容會進到最終映像。
    if (/^FROM\s/i.test(t)) {
      stage++;
      workdir = '/';
      continue;
    }
    if (/^WORKDIR\s/i.test(t)) {
      workdir = t.split(/\s+/)[1];
      continue;
    }
    if (!/^COPY\s/i.test(t)) continue;
    const tokens = t.split(/\s+/).slice(1);
    const flags = tokens.filter((x) => x.startsWith('--'));
    const paths = tokens.filter((x) => !x.startsWith('--'));
    if (paths.length < 2) continue;
    const dest = paths[paths.length - 1];
    const from = flags.find((f) => f.startsWith('--from='))?.slice(7) ?? null;
    for (const src of paths.slice(0, -1)) {
      out.push({
        from,
        stage,
        src,
        // 映像裡的絕對路徑。dest 以 / 結尾或有多個來源時是目錄。
        dest: dest.startsWith('/')
          ? dest.replace(/\/+$/, '') || '/'
          : join(workdir, dest).replace(/\/+$/, '') || '/',
        multi: paths.length > 2 || dest.endsWith('/'),
        line: t,
      });
    }
  }
  return out;
}

/** .dockerignore 的非否定樣式（只做前綴比對，夠用來擋掉「複製了卻被排除」）。 */
function ignorePatterns(ctx) {
  const f = join(ROOT, ctx, '.dockerignore');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
    .map((l) => l.replace(/^\.\//, '').replace(/\/+$/, ''));
}

check('COPY 的來源都存在，而且沒有被 .dockerignore 排除掉', () => {
  for (const [df, ctx] of Object.entries(DOCKERFILES)) {
    if (!existsSync(join(ROOT, df))) continue;
    const ignored = ignorePatterns(ctx);
    for (const c of parseCopies(df)) {
      // --from=<stage> 的來源是前一階段的產物，不在 repo 裡。
      if (c.from) continue;
      if (/[*?[]/.test(c.src)) continue; // 萬用字元交給 Docker
      if (c.src === '.') continue;
      assert(
        existsSync(join(ROOT, ctx, c.src)),
        `${df} 複製 ${c.src}，但建置脈絡（${ctx}）裡沒有這個路徑：\n       ${c.line}`,
      );
      // **這一項比「來源存在」更容易漏。** 加了 .dockerignore 之後，
      // 來源還在 repo 裡，只是 Docker 看不到它 —— COPY 直接失敗，
      // 而錯誤訊息只說「file not found」，看起來像是檔案被刪了。
      const hit = ignored.find((p) => c.src === p || c.src.startsWith(`${p}/`));
      assert(
        !hit,
        `${df} 要複製 ${c.src}，但 ${ctx}/.dockerignore 用 "${hit}" 把它排除了，建置會失敗`,
      );
    }
  }
});

check('容器裡跑的腳本，它 import 的東西真的在映像裡', () => {
  // scripts/*.mjs 是 migrate 與 worker 兩個服務的進入點。它們用相對
  // 路徑 import `../lib/*.mjs`，而**映像裡的相對位置與 repo 不同**：
  // repo 是 apps/web/scripts → apps/web/lib，映像是 /app/scripts → /app/lib。
  // 只複製 scripts 而沒複製 lib 的話，migrate 容器起來第一秒就
  // ERR_MODULE_NOT_FOUND，web 的 depends_on 是 service_completed_successfully，
  // 於是整套堆疊停在那裡 —— 而 npm test 全綠。
  const all = parseCopies('apps/web/Dockerfile');
  // 只看最終階段：builder 階段複製了什麼與最終映像無關。
  const last = Math.max(...all.map((c) => c.stage));
  const copies = all.filter((c) => c.stage === last && !c.from);

  /** 映像路徑 → 建置脈絡裡的路徑（找不到對應就是 null）。 */
  const toRepo = (imgPath) => {
    for (const c of copies) {
      if (imgPath === c.dest) return c.multi ? join(c.src, imgPath.split('/').pop()) : c.src;
      if (imgPath.startsWith(`${c.dest}/`)) {
        return join(c.src, imgPath.slice(c.dest.length + 1));
      }
    }
    return null;
  };
  const imageHas = (imgPath) => {
    const repoPath = toRepo(imgPath);
    return repoPath !== null && existsSync(join(ROOT, repoPath));
  };

  for (const c of copies) {
    const abs = join(ROOT, c.src);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    for (const name of readdirSync(abs)) {
      if (!name.endsWith('.mjs')) continue;
      const imgDir = c.dest;
      const src = readFileSync(join(abs, name), 'utf8');
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
        const target = join(imgDir, m[1]);
        assert(
          imageHas(target),
          `${c.src}/${name} import 了 ${m[1]}，在映像裡是 ${target}，` +
            `但 apps/web/Dockerfile 沒有把任何東西複製到那裡。\n       ` +
            `容器一啟動就 ERR_MODULE_NOT_FOUND。`,
        );
      }
    }
  }
});

check('容器裡用 npx 跑的執行檔，node_modules/.bin 有被複製進來', () => {
  // npx 找不到本地執行檔時**不會報錯，它會去 registry 抓一份**。
  // 離線機器上遷移直接失敗；有網路的機器則靜默換一個版本的 Prisma
  // 去動 schema —— 後者更糟，因為它會成功。
  const df = read('apps/web/Dockerfile');
  const users = [];
  for (const name of readdirSync(join(ROOT, 'apps/web/scripts'))) {
    const text = readFileSync(join(ROOT, 'apps/web/scripts', name), 'utf8');
    for (const m of text.matchAll(/['"]npx['"]\s*,\s*\[\s*['"]([\w@/-]+)['"]/g)) {
      users.push(`${name} → npx ${m[1]}`);
    }
  }
  assert(
    users.length === 0 || /node_modules\/\.bin/.test(df),
    `這幾處在容器裡用 npx：\n       ${users.join('\n       ')}\n       ` +
      `但 Dockerfile 沒有複製 node_modules/.bin。`,
  );
});

check('建置階段拿得到 lib/env.ts 要求的必填設定', () => {
  // `next build` 為了讀每個路由的 segment config 會真的 require 一次
  // route 模組，而 app/api/import/route.ts → lib/storage.ts → lib/env.ts
  // 在載入時就驗證設定。建置機器上沒有資料庫密碼，於是整個建置以
  // 「Next.js build worker exited with code: 78」結束——訊息裡一個字
  // 都沒提到設定，安裝腳本停在第 3／7 步。
  const vars = stageEnvVars('apps/web/Dockerfile', (s) => /npm run build/.test(s));
  assert(vars, 'apps/web/Dockerfile 找不到執行 npm run build 的階段');
  const missing = requiredWebEnv().filter((v) => !vars.has(v));
  assert(
    missing.length === 0,
    `建置階段沒有這幾個必填設定：${missing.join('、')}。\n       ` +
      `next build 會以 exit 78 失敗。請在 builder 階段補上明顯是假的值` +
      `（主機名用 .invalid），ENV 不跨階段，不會進到最終映像。`,
  );
});

check('建置脈絡有 .dockerignore', () => {
  for (const [df, ctx] of Object.entries(DOCKERFILES)) {
    if (!existsSync(join(ROOT, df))) continue;
    // 只要求脈絡裡真的有大東西的那幾個。deploy/backup 只有兩個檔案，
    // 逼它也放一份只是噪音。
    const heavy = ['node_modules', '.next', '__pycache__'].filter((d) =>
      existsSync(join(ROOT, ctx, d)),
    );
    if (!heavy.length) continue;
    const ig = join(ROOT, ctx, '.dockerignore');
    assert(
      existsSync(ig),
      `${ctx} 底下有 ${heavy.join('、')} 卻沒有 .dockerignore。\n       ` +
        `這些會整包送進建置脈絡（好幾百 MB），而且 builder 階段的 ` +
        `\`COPY . .\` 會用宿主機的 node_modules 蓋掉映像裡裝好的那一份 —— ` +
        `原生模組與 Prisma engine 的平台就對不上了。`,
    );
    const patterns = ignorePatterns(ctx);
    for (const d of heavy) {
      assert(
        patterns.includes(d),
        `${ctx}/.dockerignore 沒有排除 ${d}`,
      );
    }
  }
});

console.log('\n\x1b[1m── Compose\x1b[0m');

const compose = (() => {
  try {
    return JSON.parse(
      // 帶上兩個 profile。不帶的話 caddy 與整組監控服務根本不會出現在
      // 輸出裡，下面每一項檢查都會安靜地跳過它們 —— 而「檢查跳過了」
      // 與「檢查通過了」在畫面上長得一模一樣。
      execFileSync('docker', [
        'compose', '--profile', 'caddy', '--profile', 'monitoring',
        'config', '--format', 'json',
      ], {
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

  check('web 容器拿得到 lib/env.ts 要求的每一個必填設定', () => {
    // lib/env.ts 在模組載入時就驗證設定，缺一項就 process.exit(78)。
    // **漏掉的症狀不是啟動失敗。** readyz 不經過 lib/env.ts，所以容器
    // 是健康的、裝機驗收全綠；等到第一個真的用到 lib/storage.ts 的
    // 請求進來（老師上傳題本）才把整個 web 行程帶走。
    // **只看最終階段的 ENV。** builder 階段那組是刻意的假值，
    // 拿它來充數的話，正式環境缺設定就檢查不出來了。
    const fromImage = stageEnvVars('apps/web/Dockerfile', (s) => /^CMD\s/m.test(s)) ?? new Set();
    const env = compose.services.web?.environment ?? {};
    const missing = requiredWebEnv().filter((v) => !(v in env) && !fromImage.has(v));
    assert(
      missing.length === 0,
      `web 服務沒有拿到這幾個必填設定：${missing.join('、')}。\n       ` +
        `lib/env.ts 會 process.exit(78)，而且是在第一個用到它的請求進來時，` +
        `不是在啟動時 —— 裝機驗收看不出來。`,
    );
  });

  check('先後有依賴的服務都用了 condition，不是只寫服務名', () => {
    // depends_on 的簡寫（只寫服務名）只保證「容器被建立了」，不保證
    // 它能服務。migrate 會在 Postgres 還在跑 initdb 時就連線失敗；
    // worker 會在資料表還不存在時就開始消費佇列。
    const needs = {
      migrate: { postgres: 'service_healthy' },
      web: { migrate: 'service_completed_successfully', postgres: 'service_healthy' },
      worker: { migrate: 'service_completed_successfully' },
    };
    for (const [svc, deps] of Object.entries(needs)) {
      const actual = compose.services[svc]?.depends_on;
      if (!actual) continue;
      for (const [dep, cond] of Object.entries(deps)) {
        assert(
          actual[dep]?.condition === cond,
          `${svc} 對 ${dep} 的相依應該是 ${cond}，目前是 ` +
            `${actual[dep]?.condition ?? '（沒有這一項）'}`,
        );
      }
    }
  });

  check('掛進容器的 repo 檔案都真的存在', () => {
    // Docker 對不存在的 bind 來源不會報錯 —— 它幫你建一個空目錄。
    // 於是設定檔「掛上去了」但內容是空的，服務照樣啟動、行為卻不同：
    // 空的 Grafana provisioning 目錄會蓋掉預設的，所有面板都 No data。
    const bad = [];
    for (const [name, svc] of Object.entries(compose.services)) {
      for (const v of svc.volumes ?? []) {
        if (v.type !== 'bind' || !v.source?.startsWith(ROOT)) continue;
        const rel = v.source.slice(ROOT.length + 1);
        if (existsSync(v.source)) continue;
        // 執行期才產生的（憑證、維護頁、備份、模型快取）不算 —— 它們
        // 在 .gitignore 裡，本來就不該存在於全新 clone。
        //
        // 尾斜線的兩種寫法都要問一次：.gitignore 的
        // `deploy/caddy/certs/` 只匹配目錄，而路徑不存在時 git 無從
        // 判斷它是不是目錄，不補斜線就會漏判。
        const ignored = [rel, `${rel}/`].some((p) => {
          try {
            execFileSync('git', ['check-ignore', '-q', p], { cwd: ROOT, stdio: 'ignore' });
            return true;
          } catch {
            return false;
          }
        });
        if (ignored) continue;
        bad.push(`${name} 掛了 ${rel}，但 repo 裡沒有這個路徑`);
      }
    }
    assert(bad.length === 0, bad.join('\n       '));
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

check('種子 SQL 會設定租戶脈絡', () => {
  // RLS 開啟（ENABLE ＋ FORCE）之後，psql 直接灌進去的種子資料
  // 一列都進不去：INSERT 撞 WITH CHECK 讓整個交易 abort，
  // **UPDATE 更糟 —— 比對不到任何一列，0 rows，而且不報錯。**
  // 兩種結果都是「腳本跑完了，資料庫裡什麼都沒有」。
  const dir = join(ROOT, 'packages/db/seed');
  if (!existsSync(dir)) return;
  const rlsOn = readdirSync(join(ROOT, 'packages/db/migrations')).some((d) =>
    /ENABLE ROW LEVEL SECURITY/i.test(
      readFileSync(join(ROOT, 'packages/db/migrations', d, 'migration.sql'), 'utf8'),
    ),
  );
  if (!rlsOn) return;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.sql')) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    assert(
      /SET\s+(LOCAL\s+)?app\.(tenant_id|cross_tenant)/i.test(sql) ||
        /set_config\(\s*'app\./i.test(sql),
      `packages/db/seed/${f} 沒有設定 app.tenant_id。RLS 已經開了，` +
        `這份種子資料會全部被擋掉，而且不會有錯誤訊息。`,
    );
  }
});

/** deploy/ 與 tools/ 底下所有的 .sh（相對 ROOT）。 */
function allShellScripts() {
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
  return scripts;
}

check('shell 腳本語法正確', () => {
  for (const s of allShellScripts()) {
    execFileSync('bash', ['-n', s], { cwd: ROOT, stdio: 'pipe' });
  }
});

check('shell 腳本可以執行（+x、shebang、LF 換行）', () => {
  // 三種都是「檔案內容完全正確但跑不起來」，而錯誤訊息都不指向真正的原因：
  //   · 少了 +x        → bash: ./deploy/scripts/ubuntu-install.sh: Permission denied
  //                      使用者的反應通常是加 sudo，然後得到一模一樣的訊息
  //   · CRLF 換行      → bad interpreter: /usr/bin/env bash^M: no such file or directory
  //                      經過 Windows 的隨身碟或 scp 一趟就會這樣，而
  //                      **離線安裝正是靠隨身碟搬過去的**
  //   · 少了 shebang   → 在 sh 底下被執行，陣列與 [[ ]] 全部語法錯誤
  const bad = [];
  for (const s of allShellScripts()) {
    const buf = readFileSync(join(ROOT, s));
    if (buf.includes('\r\n')) bad.push(`${s} 是 CRLF 換行（bad interpreter: …^M）`);
    if (!buf.subarray(0, 2).equals(Buffer.from('#!'))) bad.push(`${s} 沒有 shebang`);
    // 用 git 的紀錄而不是檔案系統的 mode：clone 出來的權限以 git 為準，
    // 而本機 chmod 過但沒進版控的話，別人 clone 下來仍然是壞的。
    const mode = execFileSync('git', ['ls-files', '-s', '--', s], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (mode) {
      if (!mode.startsWith('100755')) {
        bad.push(`${s} 在版控裡不是可執行的（${mode.split(' ')[0]}）：git update-index --chmod=+x ${s}`);
      }
    } else if (!(statSync(join(ROOT, s)).mode & 0o111)) {
      // 還沒進版控的，看檔案系統 —— git 是照 commit 當下的權限記錄的，
      // 現在沒有 +x 就會一路帶到別人的 clone。
      bad.push(`${s} 沒有執行權限：chmod +x ${s}`);
    }
  }
  assert(bad.length === 0, bad.join('\n       '));
});

check('文件與腳本裡提到的每一支腳本都真的存在', () => {
  // 這一項抓的是**做不到的說明**。實際發生過的：docs/INSTALL.md 教
  // 使用者跑 `build-offline-bundle.sh` 然後 `docker-install.sh --offline`，
  // 而前者不存在、後者不認得那個參數。照著文件做的人得到的是
  // 「No such file or directory」與「不認得的參數」——在一台封閉網段
  // 的機器上，那等於整條離線安裝路徑是假的。
  const sources = [
    'docker-compose.yml', '.env.example', 'README.md',
    ...readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`),
    ...allShellScripts(),
  ].filter((f) => existsSync(join(ROOT, f)));

  const missing = new Set();
  for (const f of sources) {
    const text = read(f);
    for (const m of text.matchAll(/(?:deploy\/scripts|tools)\/([a-z0-9-]+\.sh)/g)) {
      const rel = m[0];
      if (!existsSync(join(ROOT, rel))) missing.add(`${rel}（在 ${f} 被提到）`);
    }
  }
  assert(missing.size === 0, [...missing].join('\n       '));
});

check('文件裡示範的每一個腳本參數，腳本真的認得', () => {
  // 腳本統一用 `case "$1" in --xxx)` 解析參數，不認得的一律 die。
  // 所以文件寫錯一個參數，使用者不是得到降級行為，而是安裝直接中止。
  const docs = readdirSync(join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`)
    .concat('README.md')
    .filter((f) => existsSync(join(ROOT, f)));

  /**
   * 腳本認得的參數。
   *
   * **只看 `case "$1" in … esac` 這一段**，不是全文搜尋 —— 檔頭的
   * 用法註解裡本來就寫著每一個參數，全文搜尋會讓「註解裡有、
   * 解析器裡沒有」這個最常見的情況剛好檢查不出來。
   */
  const knownFlags = (script) => {
    const src = read(script);
    const start = src.indexOf('case "$1" in');
    if (start < 0) return null;
    const block = src.slice(start, src.indexOf('esac', start));
    const flags = new Set();
    for (const m of block.matchAll(/^\s*([-a-z|]+)\)/gm)) {
      for (const tok of m[1].split('|')) if (tok.startsWith('-')) flags.add(tok);
    }
    return flags;
  };

  const bad = [];
  for (const f of docs) {
    for (const m of read(f).matchAll(/(deploy\/scripts\/[a-z0-9-]+\.sh)((?:\s+--[a-z][a-z-]*)+)/g)) {
      const script = m[1];
      if (!existsSync(join(ROOT, script))) continue; // 上一項會抓
      const flags = knownFlags(script);
      if (!flags) continue; // 沒有參數解析區塊的腳本
      for (const flag of m[2].trim().split(/\s+/)) {
        if (!flags.has(flag)) {
          bad.push(
            `${f} 示範了 ${script} ${flag}，但它的 case 區塊裡沒有這個參數 —— ` +
              `執行會以「不認得的參數」中止（認得的有：${[...flags].join(' ')}）`,
          );
        }
      }
    }
  }
  assert(bad.length === 0, bad.join('\n       '));
});

check('.env 裡含空白的值都有加引號', () => {
  // **.env 會被當成 bash 腳本執行。** common.sh 的 load_env 是
  // `set -a; source .env`，所以
  //     TLS_DIRECTIVE=/a/fullchain.pem /a/privkey.pem
  // 在 bash 眼裡是「設 TLS_DIRECTIVE=/a/fullchain.pem，然後執行
  // /a/privkey.pem」——command not found，而 common.sh 開著 errexit，
  // 於是 doctor、backup、upgrade、restore **每一支**都在載入設定的
  // 那一行死掉，錯誤訊息指向一個憑證檔的路徑。
  // （Docker Compose 自己的 env-file 解析不需要引號，所以只看得到
  //   compose 正常運作的人不會發現這件事。）
  const bad = [];
  for (const line of read('.env.example').split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const value = m[2];
    if (!/\s/.test(value)) continue;
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) continue;
    bad.push(`${m[1]} 的值含空白但沒有引號：${line}`);
  }
  // 寫回 .env 的那一支也要會加引號，否則安裝當下就會種下同一顆地雷。
  assert(
    /\[\[:space:\]\]/.test(read('deploy/scripts/lib/common.sh')),
    'common.sh 的 env_set_value 沒有對含空白的值加引號。' +
      'TLS_MODE=custom 寫進去的是兩個路徑，之後每一支腳本 source .env 都會死。',
  );
  assert(bad.length === 0, bad.join('\n       '));
});

check('可能是空字串的 compose 變數用 `-` 而不是 `:-`', () => {
  // `${VAR:-預設}` 對「有設定但值是空字串」也會取預設值。
  // TLS_DIRECTIVE 正是刻意會是空字串的那一個：TLS_MODE=letsencrypt
  // 而沒填 ACME_EMAIL 時，正確的 tls 指示詞就是空的（Caddy 的裸 tls
  // 是合法的 no-op，自動 HTTPS 照常）。若寫成 `:-internal`，那個空值
  // 會被換回 internal —— 公開網域上發出一張本地 CA 憑證，每一台學生
  // 電腦都是「你的連線不是私人連線」，而所有健康檢查都是綠的。
  const yml = read('docker-compose.yml');
  assert(
    !/\$\{TLS_DIRECTIVE:-/.test(yml),
    'docker-compose.yml 用 ${TLS_DIRECTIVE:-…}。空字串會被換成預設值，' +
      'TLS_MODE=letsencrypt 的站台會拿到本地 CA 憑證。請改成 ${TLS_DIRECTIVE-…}。',
  );
});

check('TLS_MODE 的每一個值，render-caddy.sh 都認得', () => {
  // .env.example 是使用者唯一會看的清單。上面寫著某個值而
  // render-caddy.sh 的 case 沒有它時，安裝在第一步就以
  // 「不認得的 TLS_MODE」中止 —— 而使用者是照著註解填的。
  const example = read('.env.example');
  const block = example.slice(example.indexOf('TLS_MODE='), example.indexOf('ACME_EMAIL='));
  const documented = new Set(
    [...example.matchAll(/TLS_MODE=([a-z]+)/g)].map((m) => m[1]),
  );
  // 註解裡以「值    : 說明」形式列出的也算
  for (const m of block.matchAll(/^#\s*([a-z]+)\s*:/gm)) documented.add(m[1]);

  const render = read('deploy/scripts/render-caddy.sh');
  const handled = new Set();
  for (const m of render.matchAll(/^\s{2}([a-z|]+)\)$/gm)) {
    for (const v of m[1].split('|')) handled.add(v);
  }
  const unknown = [...documented].filter((v) => !handled.has(v));
  assert(
    unknown.length === 0,
    `.env.example 提到 TLS_MODE=${unknown.join('、')}，但 render-caddy.sh 不認得，安裝會中止。`,
  );
});

check('systemd unit 的佔位符，安裝腳本都會替換掉', () => {
  // unit 檔用 __YZ_ROOT__ 這類佔位符，由 ubuntu-install.sh 用 sed 代入。
  // 新增一個佔位符卻忘了加對應的 sed 時，systemd 收到的是字面上的
  // 「__YZ_USER__」——**服務在安裝當下不會被啟動，所以沒有人發現**，
  // 直到機房停電復電那天早上，補習班開門而網站是關的。
  const dir = join(ROOT, 'deploy/systemd');
  if (!existsSync(dir)) return;
  const installer = read('deploy/scripts/ubuntu-install.sh');
  const bad = [];
  for (const f of readdirSync(dir)) {
    const text = readFileSync(join(dir, f), 'utf8');
    for (const m of new Set([...text.matchAll(/__[A-Z0-9_]+__/g)].map((x) => x[0]))) {
      if (!installer.includes(m)) bad.push(`deploy/systemd/${f} 的 ${m} 沒有任何腳本會替換`);
    }
  }
  assert(bad.length === 0, bad.join('\n       '));
});

check('.env.example 標了 [自動] 的欄位，gen-secrets.sh 真的會產生', () => {
  // 標了卻沒實作的話，使用者照著說明「不要手填」，而安裝腳本的
  // require_env 會在第一步就擋下來說它是空的 —— 兩邊說法互相矛盾，
  // 而正確做法（自己想一個密碼填進去）沒有寫在任何地方。
  const lines = read('.env.example').split('\n');
  const marked = [];
  for (const [i, l] of lines.entries()) {
    if (!/\[自動\]/.test(l)) continue;
    for (const next of lines.slice(i + 1, i + 4)) {
      const m = next.match(/^([A-Z][A-Z0-9_]*)=/);
      if (m) { marked.push(m[1]); break; }
    }
  }
  const gen = read('deploy/scripts/gen-secrets.sh');
  const missing = marked.filter((v) => !new RegExp(`\\[${v}\\]=`).test(gen));
  assert(
    missing.length === 0,
    `.env.example 說這幾項由 gen-secrets.sh 產生，但它的 FIELDS 裡沒有：${missing.join('、')}`,
  );
});

check('compose bind mount 的宿主機目錄，安裝腳本會先建立', () => {
  // Docker 對不存在的 bind 來源不報錯 —— 它以 **root:root** 幫你建一個。
  // 這幾個目錄都在 .gitignore 裡（憑證、維護頁、模型快取不進版控），
  // 所以全新 clone 上必然不存在、必然變成 root 的。後果：
  //   · upgrade.sh 以一般使用者寫 deploy/caddy/maintenance/index.html
  //     → Permission denied，而那一步正好在「備份做完、遷移還沒開始」
  //   · TLS_MODE=custom 的人把憑證放進 deploy/caddy/certs 時寫不進去
  //   · 備份目錄變成 root 的，宿主機上手動跑 backup.sh／restore.sh 全部失敗
  //     —— 而那三支正是「出事那天」才第一次被執行的腳本
  if (!compose) return;
  const installers = ['deploy/scripts/docker-install.sh', 'deploy/scripts/ubuntu-install.sh']
    .filter((f) => existsSync(join(ROOT, f)))
    .map(read)
    .join('\n');

  const bad = [];
  for (const svc of Object.values(compose.services)) {
    for (const v of svc.volumes ?? []) {
      if (v.type !== 'bind' || !v.source?.startsWith(ROOT)) continue;
      const rel = v.source.slice(ROOT.length + 1);
      if (existsSync(v.source)) continue; // 版控裡就有，不必建
      const ignored = [rel, `${rel}/`].some((p) => {
        try {
          execFileSync('git', ['check-ignore', '-q', p], { cwd: ROOT, stdio: 'ignore' });
          return true;
        } catch { return false; }
      });
      if (!ignored) continue; // 由別的檢查負責
      if (!installers.includes(rel)) {
        bad.push(`${rel} 是 bind mount 來源、不在版控裡，而安裝腳本沒有先建立它（Docker 會建成 root 的）`);
      }
    }
  }
  // BACKUP_DIR 解析後是絕對路徑（預設 /var/backups/yunzhi），
  // 落在 ROOT 之外，上面的迴圈看不到它，但它是最容易出事的一個。
  assert(
    /install -d[^\n]*BACKUP_DIR/.test(installers) || /mkdir -p "?\$\{?BACKUP_DIR/.test(installers),
    '安裝腳本沒有建立 BACKUP_DIR。預設是 /var/backups/yunzhi，一般使用者建不出來，' +
      'Docker 會建成 root 的，於是宿主機上的 backup.sh／restore.sh／verify-restore.sh 全部寫不進去。',
  );
  assert(bad.length === 0, bad.join('\n       '));
});

check('PostgreSQL 映像帶得動初始化 SQL 要建的擴充功能', () => {
  // deploy/postgres/init/01-extensions.sql 建 vector，而 vector 不在
  // 官方 postgres 映像裡。有人為了「單純一點」把映像換成 postgres:16
  // 的話，初始化 SQL 在第一次啟動就失敗 —— 而 Postgres 的官方進入點
  // **只在資料目錄是空的時候跑初始化**，所以修好之後還要先把 volume
  // 刪掉才會重跑。第一次遷移會死在 vector 型別上。
  const initFile = 'deploy/postgres/init/01-extensions.sql';
  if (!existsSync(join(ROOT, initFile))) return;
  const sql = read(initFile);
  const needsVector = /CREATE EXTENSION[^;]*\bvector\b/i.test(sql);
  if (!needsVector) return;
  const image = compose
    ? compose.services.postgres?.image ?? ''
    : (read('docker-compose.yml').match(/image:\s*(\S*pgvector\S*|\S*postgres\S*)/) ?? ['', ''])[1];
  assert(
    /pgvector|timescale|vectordb/i.test(image),
    `初始化 SQL 要建 vector 擴充，但 postgres 映像是 ${image || '（讀不到）'}，裡面沒有 pgvector。` +
      '第一次啟動的初始化就會失敗，而且要刪掉 volume 才會重跑。',
  );
  // pg_stat_statements 必須先在 shared_preload_libraries 裡，
  // 否則 CREATE EXTENSION 直接報錯，整個 init 腳本中止 ——
  // 連帶讓後面的 vector 與 pg_trgm 也沒建起來。
  if (/CREATE EXTENSION[^;]*pg_stat_statements/i.test(sql)) {
    assert(
      /shared_preload_libraries\s*=\s*'[^']*pg_stat_statements/.test(read('deploy/postgres/postgresql.conf')),
      'init SQL 要建 pg_stat_statements，但 postgresql.conf 的 shared_preload_libraries 沒有載入它。' +
        'CREATE EXTENSION 會直接失敗並中止整份 init 腳本，連 vector 都不會建起來。',
    );
  }
});

check('容器映像都釘了版本，沒有 latest', () => {
  // `docker compose build --pull` 與 `docker pull` 在半年後跑一次，
  // latest 可能已經是下一個大版本。Postgres 大版本換掉之後資料目錄
  // 不相容，容器起不來，而**那一刻通常是升級或災難還原的當下**。
  const bad = [];
  if (compose) {
    for (const [name, svc] of Object.entries(compose.services)) {
      const img = svc.image ?? '';
      if (!img || img.startsWith('yunzhi/')) continue; // 自家映像的標籤是 APP_VERSION
      if (!img.includes(':') || img.endsWith(':latest')) bad.push(`${name} 用 ${img}`);
    }
  }
  for (const f of ['apps/web/Dockerfile', 'apps/ai/Dockerfile', 'deploy/backup/Dockerfile']) {
    if (!existsSync(join(ROOT, f))) continue;
    for (const m of read(f).matchAll(/^FROM\s+(\S+)/gim)) {
      const img = m[1];
      if (img.includes('$')) continue;
      if (!img.includes(':') || img.endsWith(':latest')) bad.push(`${f} 的 FROM ${img}`);
    }
  }
  assert(bad.length === 0, `這些沒有釘版本：\n       ${bad.join('\n       ')}`);
});

console.log(`\n${passed}/${passed + failed} 通過\n`);
process.exit(failed ? 1 : 0);
