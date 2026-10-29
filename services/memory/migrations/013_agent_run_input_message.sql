-- Durable background session work must retain its original user instruction;
-- use the goal for legacy rows and never expose provider continuation state.
ALTER TABLE frosh_agent_runs
  ADD COLUMN IF NOT EXISTS input_message TEXT;

UPDATE frosh_agent_runs
  SET input_message = goal
  WHERE input_message IS NULL;
