-- Optional client-supplied idempotency key on job submission.
-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "idempotency_key" TEXT;

-- The retry contract: one job per (user, key). Unique per user rather than
-- globally so two users choosing the same key value never collide. Postgres
-- treats NULLs as distinct in unique indexes, so jobs submitted without a
-- key (the common case) are unaffected. The database enforces this even if
-- two submissions race past the application-level replay check.
-- CreateIndex
CREATE UNIQUE INDEX "jobs_user_id_idempotency_key_key" ON "jobs"("user_id", "idempotency_key");
