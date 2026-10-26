CREATE TABLE IF NOT EXISTS frosh_google_connections (
  user_id TEXT PRIMARY KEY,
  encrypted_token_set TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scopes) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('connected','reconnect_required')) DEFAULT 'connected',
  access_token_expires_at TIMESTAMPTZ NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS frosh_google_oauth_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  encrypted_code_verifier TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS frosh_google_oauth_states_expiry_idx
  ON frosh_google_oauth_states (expires_at);
