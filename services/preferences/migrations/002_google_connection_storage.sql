-- Persist encrypted Google credentials and short-lived OAuth states alongside
-- the established per-user preference record. The JSON payloads are validated
-- by the Google store before use; the API never returns encrypted material.
ALTER TABLE frosh_user_preferences
  ADD COLUMN IF NOT EXISTS google_connection JSONB;

ALTER TABLE frosh_user_preferences
  ADD COLUMN IF NOT EXISTS google_oauth_states JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE frosh_user_preferences
  ADD CONSTRAINT frosh_user_preferences_google_connection_object
  CHECK (google_connection IS NULL OR jsonb_typeof(google_connection) = 'object');

ALTER TABLE frosh_user_preferences
  ADD CONSTRAINT frosh_user_preferences_google_oauth_states_object
  CHECK (jsonb_typeof(google_oauth_states) = 'object');
