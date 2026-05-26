-- Add a content-blocks column to slide_deck_slides.
--
-- For "blank slide" authoring: instead of (or in addition to) the
-- pre-rendered slide image, the author composes the slide from a list
-- of blocks — text (markdown), image, video URL, or video file. The
-- jsonb column holds the ordered list; shape is validated by
-- SlideBlockSchema on the server before write.

ALTER TABLE "slide_deck_slides"
  ADD COLUMN IF NOT EXISTS "blocks" jsonb NOT NULL DEFAULT '[]'::jsonb;
