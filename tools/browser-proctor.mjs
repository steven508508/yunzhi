#!/usr/bin/env node
/**
 * 作答畫面的考試行為偵測，在**真的 chromium** 上跑一次。
 *
 * # 為什麼這一支不能用單元測試代替
 *
 * `lib/proctor.mjs` 的合併規則有 64 條單元測試，這一支不重複測它們。
 * 它驗的是**只有在瀏覽器裡才成立或才不成立的事**：
 *
 *   · `visibilitychange`／`blur`／`focus` 真的接得到，而且接的是
 *     window 上那一個而不是輸入框失焦冒上來的那一個
 *   · 一次「切分頁」在真實瀏覽器裡會同時送出 blur 與 visibilitychange，
 *     而畫面上只留一筆離開記錄（合併真的生效）
 *   · **送出失敗時作答存檔完全不受影響**——這一條在單元測試裡驗不到，
 *     因為它是兩條管線之間的關係，而那個關係長在 React 元件裡
 *   · 分頁關閉時未結束的那一段離開，真的走得到 sendBeacon
 *
 * # 跑的是真的那一頁，不是複製品
 *
 * 用 esbuild 把 `app/(app)/take/[assignmentId]/page.tsx` 連同它真正的
 * 元件與 `lib/*.mjs` 一起打包，只替換兩個 Next 專屬的模組
 * （`next/link`、`next/navigation`）——那兩個與這一支要驗的東西無關，
 * 而留著它們就得把整個 Next 執行期搬進來。
 *
 * 複製一份「跟那一頁差不多的接線」來測是沒有意義的：**會出錯的正是
 * 那一頁自己接的那幾行**，複製品裡的接線永遠是對的。
 *
 * 用法：
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tools/browser-proctor.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'apps/web');

/**
 * playwright **不是這個 repo 的相依**。
 *
 * 把它放進 package.json 會讓每一次 `npm ci` 多裝一套瀏覽器，而部署
 * 目標是封閉網段的補習班機房——那裡連得出去的東西越少越好。所以
 * 它裝在全域，這裡兩個位置都找。
 */
async function loadPlaywright() {
  const pick = (m) => m.chromium ?? m.default?.chromium;
  try {
    const local = await import('playwright');
    if (pick(local)) return pick(local);
  } catch {
    /* 不在本地，往下找全域 */
  }
  const { execFileSync } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const g = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  // 全域那一份是 CJS，所以 `chromium` 掛在 `default` 上而不是具名匯出。
  const global = await import(pathToFileURL(path.join(g, 'playwright/index.js')).href);
  const chromium = pick(global);
  if (!chromium) throw new Error('找不到 playwright。npm i -g playwright，或裝進這個 repo。');
  return chromium;
}

const chromium = await loadPlaywright();

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`   \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } catch (e) {
    console.error(`   \x1b[31m✗\x1b[0m ${name}`);
    console.error(`     ${String(e.message).split('\n').slice(0, 6).join('\n     ')}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n\x1b[1m── ${name}\x1b[0m`);
}

// ── 打包 ─────────────────────────────────────────────────────────

const out = mkdtempSync(path.join(tmpdir(), 'yz-proctor-'));

/**
 * Next 專屬模組的替身。
 *
 * **只替換這兩個。** 元件、`lib/takeState.mjs`、`lib/proctor.mjs` 全部
 * 用真的——它們才是這一頁的行為所在。
 */
const stub = {
  name: 'next-stub',
  setup(build) {
    build.onResolve({ filter: /^next\/(link|navigation)$/ }, (a) => ({
      path: a.path,
      namespace: 'next-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'next-stub' }, (a) => {
      if (a.path === 'next/link') {
        return {
          contents: `
            import { createElement } from 'react';
            export default function Link({ href, children, ...rest }) {
              return createElement('a', { href, ...rest }, children);
            }
          `,
          loader: 'js',
          resolveDir: WEB,
        };
      }
      return {
        contents: `export function useParams() { return { assignmentId: 'A1' }; }`,
        loader: 'js',
        resolveDir: WEB,
      };
    });
  },
};

writeFileSync(
  path.join(out, 'entry.jsx'),
  `
  import { createElement } from 'react';
  import { createRoot } from 'react-dom/client';
  import Page from ${JSON.stringify(path.join(WEB, 'app/(app)/take/[assignmentId]/page.tsx'))};
  createRoot(document.getElementById('root')).render(createElement(Page));
  `,
);

await esbuild.build({
  entryPoints: [path.join(out, 'entry.jsx')],
  bundle: true,
  outfile: path.join(out, 'bundle.js'),
  format: 'iife',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [stub],
  alias: { '@': WEB },
  // 進入點寫在暫存目錄裡，所以 react 與 react-dom 要明講去哪裡找。
  nodePaths: [path.join(ROOT, 'node_modules'), path.join(WEB, 'node_modules')],
  logLevel: 'error',
});

writeFileSync(
  path.join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>take</title>
   <body><div id="root"></div><script src="/bundle.js"></script></body>`,
);

// ── 靜態伺服器 ───────────────────────────────────────────────────

const server = createServer((req, res) => {
  const name = req.url === '/' ? 'index.html' : req.url.replace(/^\//, '').split('?')[0];
  try {
    const body = readFileSync(path.join(out, name));
    res.writeHead(200, {
      'content-type': name.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('no');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ── 假的 API ─────────────────────────────────────────────────────

const ATTEMPT = 'AT1';

function question(order) {
  return {
    order,
    questionId: `Q${order}`,
    type: 'SINGLE_CHOICE',
    score: 5,
    content: `第 ${order} 題的題幹`,
    contentAssets: null,
    subLabel: null,
    stimulus: null,
    stimulusLabel: null,
    groupId: null,
    options: [1, 2, 3, 4].map((k) => ({
      key: k,
      label: `(${k})`,
      content: `選項 ${k}`,
      assets: null,
    })),
    slots: null,
    answerKeys: [],
    answerText: null,
    answerSlots: null,
    flagged: false,
  };
}

const TASK = {
  assignmentId: 'A1',
  title: '第一次段考 數學A',
  paperTitle: '第一次段考 數學A',
  subjectName: '數學A',
  mode: 'EXAM',
  openAt: null,
  dueAt: null,
  timeLimitMin: 50,
  allowLate: false,
  maxAttempts: 1,
  questionCount: 4,
  state: 'OPEN',
  attemptsUsed: 0,
  openAttemptId: null,
  openRemainingSeconds: null,
  lastSubmittedAt: null,
  lastLate: false,
  score: null,
  maxScore: null,
  resultLevel: 'NONE',
  resultVisible: false,
  resultNote: '',
};

const VIEW = {
  attemptId: ATTEMPT,
  assignmentId: 'A1',
  assignmentTitle: '第一次段考 數學A',
  paperTitle: '第一次段考 數學A',
  instructions: null,
  mode: 'EXAM',
  attemptNo: 1,
  status: 'IN_PROGRESS',
  startedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 50 * 60_000).toISOString(),
  remainingSeconds: 3000,
  serverNow: new Date().toISOString(),
  submittedAt: null,
  late: false,
  autoSubmitted: false,
  questions: [1, 2, 3, 4].map(question),
  totalScore: 20,
};

// ── 開跑 ─────────────────────────────────────────────────────────

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

/**
 * 主控台上的錯誤。
 *
 * **未處理的 rejection 要抓**：`requestFullscreen` 在無頭瀏覽器上會
 * reject，而沒有被吞掉的話學生會在考試中看到一行紅字，然後以為
 * 考卷壞了。故意回 500 造成的「Failed to load resource」不算——
 * 那正是這一支要製造的情況。
 */
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message ?? e}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const text = m.text();
  if (/Failed to load resource|status of 5\d\d/.test(text)) return;
  errors.push(`console: ${text}`);
});

/** 這一輪收到的東西。行為事件與作答存檔分開記，因為要驗的是兩者的關係。 */
const seen = { proctor: [], answers: [], proctorHits: 0 };
/** 行為事件的那一支要不要故意失敗。 */
let failProctor = false;

await page.route('**/api/attempts**', async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const json = (body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  if (url.pathname.endsWith('/proctor')) {
    seen.proctorHits++;
    const body = JSON.parse(req.postData() ?? '{}');
    if (failProctor) {
      // 500：前端應該留著下一輪再試，而且**完全不影響作答存檔**。
      return json({ error: '故意失敗' }, 500);
    }
    seen.proctor.push(...(body.events ?? []));
    return json({ accepted: body.events?.length ?? 0, dropped: 0, reason: 'OK' });
  }
  if (url.pathname.endsWith('/answers')) {
    const body = JSON.parse(req.postData() ?? '{}');
    seen.answers.push(...(body.answers ?? []));
    return json({ ok: true, saved: body.answers?.length ?? 0, failed: [], remainingSeconds: 2900 });
  }
  if (url.pathname === '/api/attempts' && req.method() === 'POST') return json(VIEW);
  if (url.pathname === '/api/attempts') return json({ task: TASK });
  // GET /api/attempts/<id>：校時
  return json({
    attemptId: ATTEMPT,
    status: 'IN_PROGRESS',
    remainingSeconds: 2900,
    serverNow: new Date().toISOString(),
    expiresAt: VIEW.expiresAt,
    submittedAt: null,
    late: false,
    autoSubmitted: false,
    answered: seen.answers.length,
    total: 4,
  });
});

/**
 * 把 `document.visibilityState` 換成可以改的。
 *
 * 只 dispatch 事件而不改 `visibilityState` 的話，作答頁讀到的仍然是
 * 'visible'，於是「切走」那一條分支根本不會執行——測試會通過而
 * 什麼都沒驗到。
 */
async function setHidden(hidden) {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (h ? 'hidden' : 'visible'),
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

const fire = (target, type) =>
  page.evaluate(
    ([t, ty]) => (t === 'win' ? window : document).dispatchEvent(new Event(ty)),
    [target, type],
  );

/** 等到伺服器收到至少 n 筆行為事件（前端是每 4 秒攢一次才送）。 */
async function waitEvents(n, ms = 12_000) {
  const until = Date.now() + ms;
  while (seen.proctor.length < n && Date.now() < until) {
    await page.waitForTimeout(150);
  }
}

async function startExam() {
  await page.goto(`${base}/`);
  await page.getByRole('button', { name: '開始作答' }).click();
  await page.waitForSelector('.yz-take__q');
  // 無頭 chromium **真的會給全螢幕**，所以開場那一筆 FULLSCREEN_ENTER
  // 是正常的。等它送完再清掉，否則後面每一條斷言都要為它讓路。
  await page.waitForTimeout(6_000);
  seen.proctor.length = 0;
}

/**
 * 假裝全螢幕狀態。
 *
 * **兩個屬性都要蓋。** 只蓋標準那一個的話，`isFullscreen()` 會落到
 * `webkitFullscreenElement` 上而那是瀏覽器真實的狀態——於是「離開
 * 全螢幕」永遠測不到，而測試會安靜地通過。
 */
async function setFullscreen(on) {
  await page.evaluate((v) => {
    for (const key of ['fullscreenElement', 'webkitFullscreenElement']) {
      Object.defineProperty(document, key, {
        configurable: true,
        get: () => (v ? document.documentElement : null),
      });
    }
    document.dispatchEvent(new Event('fullscreenchange'));
  }, on);
}

try {
  section('開始之前要先告知');

  await page.goto(`${base}/`);
  await page.waitForSelector('.yz-take__brief');

  await test('brief 上明講會記錄切換分頁與離開全螢幕', async () => {
    const text = await page.locator('.yz-take__brief').innerText();
    assert.match(text, /切換分頁/, '沒有告知就記錄是另一個問題');
    assert.match(text, /全螢幕/);
    assert.match(text, /老師看得到/);
  });

  await test('措辭裡說明系統不會自動判定，也不記錄貼上的內容', async () => {
    const text = await page.locator('.yz-take__brief').innerText();
    assert.match(text, /不會據此自動判定|不會自動判定/);
    assert.match(text, /不會記錄貼上的內容/);
    for (const banned of ['監控', '作弊', '違規']) {
      assert.ok(!text.includes(banned), `告知的措辭裡出現了「${banned}」`);
    }
  });

  section('事件真的被記錄');

  await startExam();

  await test('切走再切回，伺服器收到一筆帶長度的離開', async () => {
    seen.proctor.length = 0;
    await setHidden(true);
    await fire('win', 'blur');
    await page.waitForTimeout(2_500);
    await setHidden(false);
    await fire('win', 'focus');
    await waitEvents(1);
    assert.equal(
      seen.proctor.length,
      1,
      `收到 ${JSON.stringify(seen.proctor.map((x) => [x.type, x.durationMs]))}`,
    );
    const [e] = seen.proctor;
    assert.equal(e.type, 'TAB_VISIBLE', `型別是 ${e.type}`);
    assert.ok(e.durationMs >= 2_000, `長度 ${e.durationMs}ms，應該接近 2.5 秒`);
    assert.ok(e.atOffsetMs >= 0, '送出去的是「幾毫秒之前」，不可以是負的');
  });

  await test('記下當時在第幾題', async () => {
    seen.proctor.length = 0;
    await page.getByRole('button', { name: /^第 3 題/ }).click();
    await setHidden(true);
    await page.waitForTimeout(2_000);
    await setHidden(false);
    await waitEvents(1);
    assert.equal(seen.proctor[0].questionOrder, 3);
  });

  await test('一次切分頁同時送出 blur 與 visibilitychange，只留一筆', async () => {
    seen.proctor.length = 0;
    // 真實瀏覽器切分頁就是這個順序。分開記的話老師會看到兩次離開。
    await fire('win', 'blur');
    await setHidden(true);
    await page.waitForTimeout(2_200);
    await setHidden(false);
    await fire('win', 'focus');
    await waitEvents(1);
    await page.waitForTimeout(5_000); // 再等一輪，確認沒有第二筆跟著來
    assert.equal(seen.proctor.length, 1, `收到 ${seen.proctor.length} 筆，一個動作應該只有 1 筆`);
  });

  section('去抖動真的生效');

  await test('連續的短暫 blur/focus 不會變成一堆筆數', async () => {
    seen.proctor.length = 0;
    const before = seen.proctorHits;
    // 模擬手機切輸入法：blur/focus × 6，每次約 200ms、間隔約 200ms。
    for (let i = 0; i < 6; i++) {
      await fire('win', 'blur');
      await page.waitForTimeout(200);
      await fire('win', 'focus');
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(6_000);
    assert.ok(
      seen.proctor.length <= 1,
      `12 個原始事件變成 ${seen.proctor.length} 筆記錄，去抖動沒有生效`,
    );
    assert.ok(seen.proctorHits - before <= 2, '不可以為了抖動一直打伺服器');
  });

  await test('完全不動時不會有任何請求', async () => {
    const before = seen.proctorHits;
    await page.waitForTimeout(6_000);
    assert.equal(seen.proctorHits, before, '沒有事件就不該送出空的批次');
  });

  section('送出失敗不影響作答存檔');

  await test('行為事件一路 500，答案照樣存得進去', async () => {
    failProctor = true;
    seen.answers.length = 0;
    const hitsBefore = seen.proctorHits;

    // 一邊製造行為事件，一邊作答。
    for (const [i, order] of [1, 2, 3, 4].entries()) {
      await page.getByRole('button', { name: new RegExp(`^第 ${order} 題`) }).click();
      await setHidden(true);
      await page.waitForTimeout(1_800);
      await setHidden(false);
      await page.locator('.yz-take__opt').nth(i % 4).click();
      await page.waitForTimeout(1_600);
    }
    await page.waitForTimeout(3_000);

    assert.ok(seen.proctorHits > hitsBefore, '應該試著送過行為事件');
    const ids = new Set(seen.answers.map((a) => a.questionId));
    assert.equal(ids.size, 4, `只存到 ${ids.size} 題的答案，行為記錄把存檔拖下水了`);
  });

  await test('存檔指示器沒有因為行為事件失敗而說「未送出」', async () => {
    // 這一條是那個關係的可見面：學生看到的必須是「已存檔」。
    const label = await page.locator('.yz-take__save').innerText();
    assert.ok(!label.includes('未送出'), `狀態列寫著「${label}」`);
    assert.match(label, /已存檔/);
  });

  await test('畫面上沒有出現任何與行為記錄有關的錯誤', async () => {
    const alerts = await page.locator('.yz-take__alerts').innerText();
    assert.ok(!alerts.includes('記錄'), `作答畫面出現了「${alerts.trim()}」`);
  });

  section('離開全螢幕');

  await test('離開全螢幕會被記錄，而且畫面上溫和提示', async () => {
    failProctor = false;
    seen.proctor.length = 0;
    await setFullscreen(true);
    await page.waitForTimeout(2_000);
    await setFullscreen(false);
    await waitEvents(1);
    const kinds = seen.proctor.map((e) => e.type);
    assert.ok(
      kinds.includes('FULLSCREEN_EXIT'),
      `收到的是 ${kinds.join('、') || '(空)'}，共打了 ${seen.proctorHits} 次`,
    );

    const alerts = await page.locator('.yz-take__alerts').innerText();
    assert.match(alerts, /離開了全螢幕/);
    assert.match(alerts, /不會影響你的成績/, '提示要說得出後果，而後果只有「被記錄」');
  });

  await test('離開全螢幕不會擋住鍵盤或跳出強制回全螢幕的對話框', async () => {
    // 按鍵仍然要能選答案。擋鍵盤擋不住真的想作弊的人，
    // 只會讓一個按到 Esc 的正常學生不知所措。
    seen.answers.length = 0;
    await page.getByRole('button', { name: /^第 2 題/ }).click();
    await page.keyboard.press('4');
    await page.waitForTimeout(2_000);
    assert.ok(
      seen.answers.some((a) => a.questionId === 'Q2' && a.answerKeys?.includes(4)),
      '離開全螢幕之後鍵盤就不能作答了',
    );
    assert.equal(await page.locator('dialog[open]').count(), 0, '不可以跳對話框把人擋住');
  });

  section('分頁關閉時未結束的事件');

  await test('切走之後直接關掉分頁，那一段會走 sendBeacon 送出去', async () => {
    seen.proctor.length = 0;
    // sendBeacon 在 Playwright 的路由攔截下不一定送得出去，所以這裡
    // 換掉它並把 payload 收下來——要驗的是「有沒有走到這條路、
    // 送的是不是那一段未結束的離開」。
    await page.evaluate(() => {
      window.__beacons = [];
      navigator.sendBeacon = (url, blob) => {
        blob.text().then((t) => window.__beacons.push({ url, body: t }));
        return true;
      };
    });
    await setHidden(true);
    await fire('win', 'blur');
    await page.waitForTimeout(1_000);
    await fire('win', 'pagehide');
    await page.waitForTimeout(500);

    const beacons = await page.evaluate(() => window.__beacons);
    const hit = beacons.find((b) => b.url.includes('/proctor'));
    assert.ok(hit, `beacon 沒有送到 /proctor（送了 ${beacons.length} 次）`);
    const events = JSON.parse(hit.body).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'TAB_HIDDEN', '未結束的那一段記在離開的時刻');
    assert.equal(events[0].durationMs, null, '不知道多久就是 null，不是 0');
  });

  await test('答案的 beacon 也一起送了——兩條線互不影響', async () => {
    const beacons = await page.evaluate(() => window.__beacons);
    assert.ok(
      beacons.some((b) => b.url.includes('/answers')) || seen.answers.length > 0,
      '行為記錄的 beacon 不可以擠掉答案的 beacon',
    );
  });

  section('主控台');

  await test('整個過程沒有未處理的錯誤', async () => {
    assert.deepEqual(errors, [], errors.join('\n'));
  });
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} 通過，${failed} 失敗\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
