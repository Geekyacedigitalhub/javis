ALTER TABLE frosh_missions ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS frosh_missions_lease_idx ON frosh_missions(status, lease_until);
