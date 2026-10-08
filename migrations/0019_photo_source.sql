-- Photos copied from a page or post (a Scout draft, or a link someone pasted) say where they came from,
-- so the pop-up sheet can credit the page and the admin can take one down. Nullable: uploads leave them empty.
ALTER TABLE popup_images ADD COLUMN source_url TEXT;   -- the page or post the photo was taken from
ALTER TABLE popup_images ADD COLUMN credit TEXT;       -- shown as "Photo: <credit>", the site name
ALTER TABLE popup_images ADD COLUMN origin_url TEXT;   -- the image address itself, so the same photo is not added twice
