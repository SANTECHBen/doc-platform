-- Per-instance hero image override. Falls back to asset_models.image_storage_key
-- when null. Lets a site upload a photo of *their* unit (different finish,
-- different surrounding context, etc.) without affecting the model SKU's
-- canonical photo.

ALTER TABLE "asset_instances" ADD COLUMN IF NOT EXISTS "image_storage_key" text;
