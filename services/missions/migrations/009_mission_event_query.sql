CREATE INDEX IF NOT EXISTS frosh_mission_events_mission_created_id_idx
  ON frosh_mission_events(mission_id, created_at DESC, id DESC);
