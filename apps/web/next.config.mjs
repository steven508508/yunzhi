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
  experimental: {
    // 作答頁會有大量小型互動，關掉可以少一點 hydration 抖動
    optimizePackageImports: ['zod'],
  },
};

export default nextConfig;
