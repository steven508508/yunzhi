#!/usr/bin/env node
/**
 * 把元件校樣渲染成一個獨立的 HTML 檔。
 *
 *   node tools/build-gallery.mjs
 *
 * 為什麼要有它：要看元件長什麼樣，本來得起開發伺服器、開瀏覽器、
 * 找到那個路由。這一支直接產一個檔，用瀏覽器打開就好——
 * 而且它渲染的是**真的元件**，不是另外手刻一份示意圖。
 * 手刻的示意圖會與程式碼分岐，然後你看到的漂亮版本跟系統裡的
 * 不是同一個東西。
 *
 * 用 esbuild 就地編譯 TSX（專案本來就有 Next.js 的依賴樹），
 * 再用 react-dom/server 轉成字串，最後把 globals.css 內嵌進去。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'apps/web');
const OUT = path.join(ROOT, 'component-gallery.html');

const esbuild = await import(pathToFileURL(path.join(ROOT, 'node_modules/esbuild/lib/main.js')).href)
  .then((m) => m.default ?? m)
  .catch(() => null);

if (!esbuild) {
  console.error('找不到 esbuild。它是 Next.js 的傳遞相依，通常已經在 node_modules 裡。');
  process.exit(1);
}

// bundle 要放在 repo 內，否則 external 的 react / react-dom
// 從 /tmp 解析不到（Node 的模組解析是照目錄往上找）。
const tmp = mkdtempSync(path.join(ROOT, 'node_modules', '.yz-gallery-'));
try {
  const entry = path.join(tmp, 'entry.jsx');
  writeFileSync(
    entry,
    `import { renderToStaticMarkup } from 'react-dom/server';
     import { Gallery } from '@/components/Gallery';
     export const html = renderToStaticMarkup(<Gallery />);`,
  );

  const bundle = path.join(tmp, 'bundle.mjs');
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    absWorkingDir: WEB,
    // 與 tsconfig 的 paths 一致
    alias: { '@': WEB },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server'],
    logLevel: 'warning',
  });

  const { html } = await import(pathToFileURL(bundle).href);
  const css = readFileSync(path.join(WEB, 'app/globals.css'), 'utf8');

  writeFileSync(
    OUT,
    `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>雲端智學 — 元件校樣</title>
<style>
${css}
</style>
</head>
<body>
${html}
</body>
</html>
`,
  );
  console.log(`元件校樣 → ${path.relative(process.cwd(), OUT)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
