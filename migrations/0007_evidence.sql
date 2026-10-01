-- Evidence for agent drafts: a quote copied word for word from the page or post that states the facts.
-- evidence_check is 'found' when the server saw the quote there, 'unchecked' when the page could not be read.
-- Only new columns, so the code deployed before this migration keeps working.
ALTER TABLE popups ADD COLUMN evidence TEXT;
ALTER TABLE popups ADD COLUMN evidence_url TEXT;
ALTER TABLE popups ADD COLUMN evidence_check TEXT CHECK (evidence_check IN ('found', 'unchecked'));
