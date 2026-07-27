/**
 * 設定驗證。
 *
 * 這個模組在應用啟動時執行一次，任何必填設定缺漏或格式錯誤都會
 * 讓行程立刻退出並印出人看得懂的訊息 —— 而不是等到某位學生
 * 按下交卷才出現 undefined 錯誤。
 *
 * 「設定錯誤要在啟動時炸掉，不要在執行時漏水」是自架系統最
 * 划算的一條紀律：機房裡沒有工程師隨時盯著日誌。
 */

import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  APP_URL: z.string().url('APP_URL 必須是完整網址，含 https://'),
  APP_DOMAIN: z.string().min(1),
  APP_VERSION: z.string().default('dev'),
  TENANT_NAME: z.string().default('雲端智學'),
  TZ: z.string().default('Asia/Taipei'),

  DATABASE_URL: z.string().startsWith('postgresql://', 'DATABASE_URL 必須是 postgresql:// 開頭'),
  REDIS_URL: z.string().startsWith('redis://'),

  AUTH_SECRET: z
    .string()
    .min(32, 'AUTH_SECRET 至少 32 字元。請執行 ./deploy/scripts/gen-secrets.sh 產生，不要自己想一個。'),
  AUTH_SESSION_MAX_AGE: z.coerce.number().int().positive().default(43200),

  S3_ENDPOINT: z.string().url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool.default('true'),
  // MinIO 沒有 region 的概念，但 SDK 要求要填。
  S3_REGION: z.string().default('us-east-1'),

  AI_SERVICE_URL: z.string().url().default('http://ai:8000'),

  // 匯入的併發。見 .env.example 的說明——這個數字不該為了求快而調大。
  IMPORT_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),

  // AI 單價表。格式錯不該讓整個系統起不來（成本估算只是顯示用），
  // 所以在這裡就驗一次並在錯的時候明說，而不是等到匯入時才靜默失效。
  AI_PRICING: z
    .string()
    .optional()
    .refine(
      (v) => {
        if (!v?.trim()) return true;
        try {
          const parsed = JSON.parse(v);
          return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        } catch {
          return false;
        }
      },
      'AI_PRICING 必須是 JSON 物件，例如 {"model-name":{"in":480,"out":2400}}。' +
        '不確定就留空，成本會記為 0，其他功能不受影響。',
    ),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  ✗ ${i.path.join('.')}: ${i.message}`,
    );
    // 直接寫 stderr 而不是 throw，因為 Next.js 會把 throw 包成
    // 一大坨堆疊，維運人員在 docker logs 裡看不到重點。
    process.stderr.write(
      [
        '',
        '════════════════════════════════════════════════════════',
        ' 雲端智學無法啟動：設定不完整',
        '════════════════════════════════════════════════════════',
        ...lines,
        '',
        ' 請檢查 .env 檔，或執行：',
        '   ./deploy/scripts/doctor.sh --config-only',
        '════════════════════════════════════════════════════════',
        '',
      ].join('\n'),
    );
    process.exit(78); // EX_CONFIG
  }

  cached = parsed.data;
  return cached;
}

export const env = loadEnv();
