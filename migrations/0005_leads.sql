CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  linkedin TEXT,
  consent INTEGER NOT NULL DEFAULT 0,
  session_avg REAL,
  source TEXT NOT NULL DEFAULT 'try-coach',
  created_at TEXT NOT NULL,
  ip_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_created ON leads (created_at);
CREATE INDEX IF NOT EXISTS idx_leads_ip ON leads (ip_hash, created_at);
