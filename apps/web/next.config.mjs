/** @type {import('next').NextConfig} */
const nextConfig = {
  // standalone 讓 Docker 映像只帶必要的 node_modules，
  // 映像從約 1.2GB 降到約 200MB —— 對自架環境的下載與備份都有感。
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  env: {
    APP_VERSION: process.env.APP_VERSION ?? 'dev',
  },
  /**
   * **關掉 Next 的圖片最佳化。** 這一行是資安措施，不是效能取捨。
   *
   * `next/image` 的最佳化是用 sharp 解碼的，而 sharp 0.34.x 繼承了
   * libvips 的四個 CVE（CVE-2026-33327／33328／35590／35591，
   * 修在 sharp 0.35.0）。next 15.5 把 sharp 釘在 ^0.34.3，npm 的
   * overrides 對它無效（試過，`npm ls` 只會記一筆 overridden 然後
   * 照樣裝 0.34.5），而升到 next 16 是另一件事。
   *
   * 今天這條路走不到：全 repo 沒有任何一個 `<Image>`，也沒有把上傳
   * 檔案原樣送出的同源路由，所以 `/_next/image` 拿不到攻擊者控制的
   * 位元組。**但那正是問題所在**——「題目裡的圖還沒接上」還在待辦
   * 清單上，而接上的那一天會出現一支同源的檔案代理路由，
   * `/_next/image?url=/api/files/<他自己上傳的圖>` 就成立了。
   * 那時候不會有人記得回來想這件事。
   *
   * 這個系統收學生手機拍的題本照片，攻擊者控制的影像位元組是
   * **常態輸入**，不是例外。所以現在就把整條路關掉：應用一張
   * `<Image>` 都沒用，關掉不損失任何東西。
   *
   * 解除條件：sharp 到 0.35 以上（多半跟著升 next）。
   * `tools/deploy-check.mjs` 有一項在盯這件事，別手動改掉這一行。
   */
  images: { unoptimized: true },

  experimental: {
    // 作答頁會有大量小型互動，關掉可以少一點 hydration 抖動
    optimizePackageImports: ['zod'],
  },
};

export default nextConfig;
