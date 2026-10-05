ALTER TABLE frosh_missions ADD COLUMN IF NOT EXISTS lease_owner TEXT;
CREATE INDEX IF NOT EXISTS frosh_missions_lease_owner_idx ON frosh_missions(lease_owner);
