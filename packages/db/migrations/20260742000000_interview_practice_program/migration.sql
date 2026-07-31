-- 面試練習掛上校系。
--
-- 四月通過第一階段的學生手上通常有兩到三個系，同一題會為每一個系
-- 各練一次，而那三份答案應該長得完全不一樣。沒有這一欄的話，練習
-- 紀錄是一條按時間排的平鋪清單，面試前一晚他找不到「台大那一版」。
--
-- 可為 null：既有的練習紀錄沒有校系，而「沒指定」是一個合法的狀態
-- （他也可能只是先練通用題）。不給預設值，因為空字串與 null 在
-- 「有沒有指定」這件事上必須分得開。
ALTER TABLE "interview_practices" ADD COLUMN "programRef" TEXT;

-- 面試前一晚的查詢是「這個系我練過哪幾題」，所以索引的順序是
-- 使用者 → 校系 → 時間，而不是把 programRef 掛在既有索引後面。
CREATE INDEX "interview_practices_userId_programRef_createdAt_idx"
  ON "interview_practices"("userId", "programRef", "createdAt");
