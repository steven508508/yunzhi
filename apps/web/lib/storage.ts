/**
 * 物件儲存（MinIO，S3 相容）。
 *
 * 題本原稿、頁面影像、學生手寫作答的掃描件都放這裡，不放資料庫。
 * 理由很現實：一份 200 頁的題本轉成頁面影像大約 200–400 MB，
 * 塞進 Postgres 會讓每一次備份都拖上好幾分鐘，而備份要能在
 * RPO 15 分鐘內完成（文件 12）。
 *
 * 鍵的設計原則：**租戶前綴在最前面**。日後要對單一租戶做
 * 生命週期規則、配額統計、或整批刪除（解約），都只需要一個
 * prefix 就能圈出範圍。
 */
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '@/lib/env';

const globalForS3 = globalThis as unknown as { s3?: S3Client };

export const s3 =
  globalForS3.s3 ??
  new S3Client({
    endpoint: env.S3_ENDPOINT,
    // MinIO 沒有真正的 region 概念，但 SDK 要求要填。
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    },
    // 熱點網路（訪談第 17 題，20–50 Mbps 分給整班）下，
    // 預設的 120 秒逾時對一份 80 MB 的掃描件是不夠的。
    requestHandler: { requestTimeout: 300_000 },
  });

if (process.env.NODE_ENV !== 'production') globalForS3.s3 = s3;

export const BUCKET = env.S3_BUCKET;

// ─────────────────────────────────────────────────────────────
// 鍵
// ─────────────────────────────────────────────────────────────

/**
 * 原稿檔。
 *
 * 檔名不進鍵 —— 老師上傳的檔名可能是「數學 期末(1).pdf」，
 * 帶空白、括號、中文。這些在 S3 鍵裡合法但會讓每一層
 * （簽章、nginx 日誌、備份腳本的 shell 迴圈）各自踩一次坑。
 * 原始檔名存在 ImportFile.fileName，鍵只用不會出錯的字元。
 */
export function importFileKey(tenantId: string, jobId: string, fileId: string, ext: string) {
  return `t/${tenantId}/import/${jobId}/src/${fileId}${normalizeExt(ext)}`;
}

/** 正規化後的頁面影像。第 1 階段產出，後續各階段共用。 */
export function importPageKey(tenantId: string, jobId: string, fileId: string, page: number) {
  return `t/${tenantId}/import/${jobId}/pages/${fileId}/${String(page).padStart(4, '0')}.png`;
}

/** 某個匯入工作的全部物件。刪工作時整批清掉。 */
export function importPrefix(tenantId: string, jobId: string) {
  return `t/${tenantId}/import/${jobId}/`;
}

function normalizeExt(ext: string) {
  const e = ext.replace(/^\.+/, '').toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(e) ? `.${e}` : '';
}

// ─────────────────────────────────────────────────────────────
// 讀寫
// ─────────────────────────────────────────────────────────────

export async function putObject(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
  meta?: Record<string, string>,
) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      // 中文檔名等非 ASCII 值在 S3 的 metadata 標頭裡會壞掉，
      // 呼叫端要先自行編碼；這裡不默默吞掉。
      Metadata: meta,
      ChecksumAlgorithm: 'SHA256',
    }),
  );
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!r.Body) throw new Error(`物件 ${key} 沒有內容`);
  return streamToBuffer(r.Body as Readable);
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/**
 * 給瀏覽器的短效下載連結。
 *
 * 刻意不讓 MinIO 直接對外 —— 授權判斷在應用層（誰能看這份題本
 * 取決於他教不教這一科），簽章只是把驗過的結果帶過去。
 * 15 分鐘足夠校對一份題本的一次載入，又短到連結外流的風險有限。
 */
export function signedGetUrl(key: string, expiresIn = 900, downloadName?: string) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ...(downloadName
        ? {
            ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(
              downloadName,
            )}`,
          }
        : {}),
    }),
    { expiresIn },
  );
}

export async function deleteObject(key: string) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

/**
 * 刪整個前綴。
 *
 * S3 沒有「刪資料夾」，要先列再刪，而且每次最多 1000 個。
 * 一份 200 頁的題本有 200+ 個物件，所以分批是必要的而非防禦性寫法。
 */
export async function deletePrefix(prefix: string): Promise<number> {
  let token: string | undefined;
  let deleted = 0;

  do {
    const list = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    const keys = (list.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);
    if (keys.length) {
      const r = await s3.send(
        new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys, Quiet: true } }),
      );
      // MinIO 會逐項回報錯誤而非整批失敗。沉默地少刪幾個物件
      // 等於留下永遠不會被清掉的垃圾，所以這裡要吵。
      if (r.Errors?.length) {
        throw new Error(
          `刪除 ${prefix} 時有 ${r.Errors.length} 個物件失敗，第一個：${r.Errors[0].Key} — ${r.Errors[0].Message}`,
        );
      }
      deleted += keys.length;
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);

  return deleted;
}

// ─────────────────────────────────────────────────────────────
// 自檢
// ─────────────────────────────────────────────────────────────

/**
 * readyz 用。只確認 bucket 可達，不做寫入測試 ——
 * 每 30 秒寫一個物件會在一年後留下一百萬個探測垃圾。
 */
export async function checkStorage(): Promise<{ ok: boolean; error?: string }> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 內容雜湊。同一份檔案重複上傳時可以直接指向既有物件。 */
export function sha256(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}
