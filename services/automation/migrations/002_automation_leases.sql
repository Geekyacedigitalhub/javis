ALTER TABLE frosh_automations
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS frosh_automations_due_lease_idx
  ON frosh_automations (status, next_run_at, lease_until);
