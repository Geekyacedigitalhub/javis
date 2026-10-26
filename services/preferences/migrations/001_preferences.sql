CREATE TABLE IF NOT EXISTS frosh_user_preferences (
  user_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('normal','focus','coding','research','voice','quiet','autonomous')) DEFAULT 'normal',
  personality TEXT NOT NULL CHECK (personality IN ('helpful','direct','warm','formal')) DEFAULT 'helpful',
  response_length TEXT NOT NULL CHECK (response_length IN ('short','balanced','detailed')) DEFAULT 'balanced',
  technical_depth TEXT NOT NULL CHECK (technical_depth IN ('plain','adaptive','expert')) DEFAULT 'adaptive',
  autonomy_level TEXT NOT NULL CHECK (autonomy_level IN ('confirm','safe','trusted')) DEFAULT 'confirm',
  notification_style TEXT NOT NULL CHECK (notification_style IN ('all','important','quiet')) DEFAULT 'important',
  voice_language TEXT NOT NULL DEFAULT 'en-NG',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
