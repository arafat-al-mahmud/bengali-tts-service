-- CreateIndex
-- Job history is always "this user's jobs, newest first, one page at a
-- time". The composite index serves that exact access path: equality on
-- user_id, then a created_at DESC range scan that matches the query's
-- ORDER BY, so pagination never sorts. A lone index on user_id would
-- fetch-and-sort every row the user ever created.
CREATE INDEX "jobs_user_id_created_at_idx" ON "jobs"("user_id", "created_at" DESC);
