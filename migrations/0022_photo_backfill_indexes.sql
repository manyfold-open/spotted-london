-- The photo backfill asks "is this picture already on other pop-ups?" for every photo it adds.
-- Without this index that question reads the whole popup_images table each time.
CREATE INDEX IF NOT EXISTS idx_images_origin ON popup_images(origin_url);
