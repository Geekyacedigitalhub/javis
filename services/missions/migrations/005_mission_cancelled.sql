ALTER TABLE frosh_missions DROP CONSTRAINT IF EXISTS frosh_missions_status_check;
ALTER TABLE frosh_missions ADD CONSTRAINT frosh_missions_status_check CHECK (status IN ('planning','running','waiting_approval','completed','failed','paused','cancelled'));
