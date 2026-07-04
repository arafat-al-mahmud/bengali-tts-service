-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Unique index makes duplicate registration a storage-layer constraint,
-- not just an application check, and backs the login lookup by email.
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
