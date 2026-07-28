-- 雲端智學 — 題目附圖
--
-- 講義的幾何題與函數題幾乎每題都有附圖。沒有圖的幾何題是不能用的
-- 題目：題幹寫著「如右圖」，學生看到的是一片空白。

-- 候選題身上的素材。[{key, bbox, labels, width, height}]
-- 校對介面要顯示它們，入庫時搬進 questions.contentAssets。
ALTER TABLE "import_candidates" ADD COLUMN "assets" JSONB;

-- 每一頁偵測到的圖。與候選題的關聯是在切分階段算出來的，
-- 但原始清單留在頁面上——重跑結構化階段時不必重新裁圖。
ALTER TABLE "import_pages" ADD COLUMN "figures" JSONB;
