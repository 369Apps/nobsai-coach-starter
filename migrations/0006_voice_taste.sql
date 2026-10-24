CREATE TABLE IF NOT EXISTS voice_taste_sessions (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  role TEXT NOT NULL,
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  overall INTEGER,
  best_moment TEXT,
  fix TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  client_secret TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_taste_ip_day ON voice_taste_sessions (ip_hash, usage_date);
CREATE INDEX IF NOT EXISTS idx_voice_taste_day ON voice_taste_sessions (usage_date, status);
