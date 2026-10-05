ALTER TABLE frosh_missions ADD COLUMN IF NOT EXISTS budget_profile TEXT NOT NULL DEFAULT 'standard' CHECK (budget_profile IN ('standard','extended','intensive'));
CREATE INDEX IF NOT EXISTS frosh_missions_budget_profile_idx ON frosh_missions(user_id,status,budget_profile);
