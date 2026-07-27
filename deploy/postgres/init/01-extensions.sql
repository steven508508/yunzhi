-- 雲端智學 — 資料庫初始化
--
-- 只在資料目錄為空時執行一次（Postgres 官方映像的行為）。
-- Prisma migration 不建立擴充功能，所以它們必須在這裡建好，
-- 否則第一次 migrate 會在 vector 型別上失敗。

-- 題目去重、知識點候選檢索、文風比對都依賴向量相似度
CREATE EXTENSION IF NOT EXISTS vector;

-- 中文題幹的模糊比對與相似題搜尋
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 慢查詢分析。沒有它，效能問題只能靠猜。
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 去除重音與全形半形正規化的輔助
CREATE EXTENSION IF NOT EXISTS unaccent;

-- WAL 歸檔目錄。archive_command 會寫到這裡，
-- 目錄不存在的話 archive_command 每次都失敗，而 Postgres
-- 會保留所有 WAL 直到磁碟寫滿 —— 這是很難診斷的當機原因。
-- 目錄由 volume 掛載建立，這裡只做存在性檢查並留下明確錯誤。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_settings WHERE name = 'archive_mode' AND setting = 'on') THEN
    RAISE WARNING '雲端智學：WAL 歸檔未啟用，RPO 將退化為 24 小時。正式環境請確認 postgresql.conf 已掛載。';
  END IF;
END $$;
