-- Machine API (/api/automations/machine/upsert): a stable per-account key so a
-- script can re-send the same campaign and update it instead of duplicating it.
-- Additive and nullable: existing rows stay NULL, and Postgres treats NULLs as
-- distinct in a unique index, so no existing campaign can conflict.

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "externalKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Automation_instagramAccountId_externalKey_key" ON "Automation"("instagramAccountId", "externalKey");
