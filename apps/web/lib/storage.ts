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

/**
 * 把一個鍵拆回租戶與匯入工作。**認不出來就回 null，不要猜。**
 *
 * 題目附圖的授權判斷需要「這張圖是哪份題本來的」才問得出「你教不教
 * 這一科」。而附圖只存在題目的 Json 欄位裡（`contentAssets`），
 * 那一欄沒有外鍵、沒有索引——要從一個鍵反查是哪一題，等於在整個
 * 題庫上做一次 Json 掃描。鍵本身已經帶著這個資訊，用它就好。
 *
 * 鍵的形狀是這個檔案自己定的（`importFileKey`／`importPageKey`），
 * 所以這裡與那幾支必須一起改。對不上的鍵一律當成「不屬於任何工作」，
 * 由呼叫端拒絕——寧可擋掉一張圖，也不要放行一個猜出來的租戶。
 */
export function parseImportKey(key: string): { tenantId: string; jobId: string } | null {
  // `..` 在 S3 的鍵裡是合法字元，不會被正規化，但它出現在這裡就代表
  // 有人在試著往上跳。真正擋住越權的是下面逐段比對租戶與工作，
  // 這一行只是讓那種請求早一點死掉、也留在日誌裡看得見。
  if (!key || key.includes('..')) return null;
  const parts = key.split('/');
  if (parts.length < 5) return null;
  const [t, tenantId, kind, jobId] = parts;
  if (t !== 't' || kind !== 'import') return null;
  if (!tenantId || !jobId) return null;
  return { tenantId, jobId };
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

// ─────────────────────────────────────────────────────────────
// 小物件的行程內快取
//
// 一個班 30 個人同時打開同一份卷子的第 7 題，就是 30 次
// GetObject。MinIO 撐得住，但那三十次要跟**同一批人的作答存檔**
// 搶同一條連線——考試當下最不能等的就是存檔。
//
// 而這些位元組是不變的：附圖的鍵帶著匯入工作的 id，工作重跑會產生
// 新的鍵，同一個鍵的內容不會被覆寫。所以快取不需要失效機制，
// 只需要一個上限。
//
// 刻意不用 Redis：多一個往返、多一個會壞的東西，而附圖總共也才
// 幾十 MB。每個 Node 行程各留一份是可以接受的重複。
// ─────────────────────────────────────────────────────────────

/** 快取總量上限。一張裁出來的圖約 20–80 KB，48 MB 大約放得下一千張。 */
const CACHE_LIMIT = 48 * 1024 * 1024;
/** 單一物件的上限。整頁的原稿影像（數 MB）不進快取，它們是校對時單人在看的。 */
const CACHE_MAX_ITEM = 512 * 1024;

type CachedObject = { buf: Buffer; etag: string };

const globalForCache = globalThis as unknown as {
  yzObjectCache?: Map<string, CachedObject>;
  yzObjectCacheBytes?: number;
};
const cache = (globalForCache.yzObjectCache ??= new Map<string, CachedObject>());

/**
 * 取物件，並記住它。回傳的 `etag` 讓路由能回 304。
 *
 * 用 Map 的插入順序做最近最少使用：命中時先 delete 再 set，把它移到
 * 尾端；滿了就從頭砍。**這不是精確的 LRU**，但快取的內容全是同一種
 * 東西（幾十 KB 的圖），精確與否影響不到什麼。
 */
export async function getObjectCached(key: string): Promise<CachedObject> {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const buf = await getObject(key);
  // ETag 用內容雜湊而不是 S3 給的：S3 的 ETag 在分段上傳時不是 MD5，
  // 而且我們要的是「同一份位元組就是同一個 ETag」，不管它從哪裡來。
  const entry: CachedObject = { buf, etag: `"${sha256(buf).slice(0, 32)}"` };

  if (buf.length <= CACHE_MAX_ITEM) {
    // 兩個請求同時 miss 同一個鍵時，兩邊都會走到這裡。**位元組數只能
    // 算一次**——`Map.set` 對既有的鍵是覆寫不是新增，而計數器多加一次
    // 就永遠回不來了：它只會單向上漲，最後每次寫入都觸發清空，
    // 快取靜靜地失效而沒有任何症狀。
    const replaced = cache.get(key);
    cache.set(key, entry);
    globalForCache.yzObjectCacheBytes =
      (globalForCache.yzObjectCacheBytes ?? 0) + buf.length - (replaced?.buf.length ?? 0);
    while ((globalForCache.yzObjectCacheBytes ?? 0) > CACHE_LIMIT) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      const victim = cache.get(oldest.value);
      cache.delete(oldest.value);
      globalForCache.yzObjectCacheBytes =
        (globalForCache.yzObjectCacheBytes ?? 0) - (victim?.buf.length ?? 0);
    }
  }
  return entry;
}

/**
 * 給瀏覽器的短效下載連結。
 *
 * 刻意不讓 MinIO 直接對外 —— 授權判斷在應用層（誰能看這份題本
 * 取決於他教不教這一科），簽章只是把驗過的結果帶過去。
 * 15 分鐘足夠校對一份題本的一次載入，又短到連結外流的風險有限。
 *
 * # 為什麼目前沒有呼叫端
 *
 * 這一支現在**在這個部署形態下用不上**，不是忘了接。MinIO 只掛在
 * compose 的 `internal` 網路，Caddy 也沒有代理它（`docker-compose.yml`、
 * `deploy/caddy/Caddyfile`）——簽名 URL 在瀏覽器上連不到。
 * 校對介面的原稿影像因此走 `/api/import/[jobId]/image`，由應用層
 * 取出位元組再送出去，權限與租戶脈絡都留在應用層。
 *
 * 哪一天 MinIO 有了對外的網址（例如另一個 vhost 或 CDN），
 * 那一支路由改成 302 到這裡產生的連結即可，權限判斷不必動。
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
