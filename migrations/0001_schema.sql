CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  target_role TEXT,
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'voice', 'live', 'coach')),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  first_pick INTEGER NOT NULL DEFAULT 0,
  headline TEXT,
  resume_text TEXT,
  makeover_json TEXT,
  streak_count INTEGER NOT NULL DEFAULT 0,
  streak_last_date TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_magic_email ON magic_links (email, created_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE daily_usage (
  user_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  text_seconds INTEGER NOT NULL DEFAULT 0 CHECK (text_seconds >= 0),
  voice_seconds INTEGER NOT NULL DEFAULT 0 CHECK (voice_seconds >= 0),
  live_seconds INTEGER NOT NULL DEFAULT 0 CHECK (live_seconds >= 0),
  PRIMARY KEY (user_id, usage_date),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX idx_usage_date ON daily_usage (usage_date);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('interview', 'action')),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL
);

CREATE INDEX idx_tasks_role ON tasks (role);

CREATE TABLE daily_assignments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  answer_text TEXT,
  score_json TEXT,
  completed_at TEXT,
  UNIQUE (user_id, usage_date),
  FOREIGN KEY (user_id) REFERENCES users (id),
  FOREIGN KEY (task_id) REFERENCES tasks (id)
);

CREATE TABLE coaching_turns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  channel TEXT NOT NULL,
  user_text TEXT,
  assistant_text TEXT,
  score_json TEXT,
  seconds_charged INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  company TEXT NOT NULL,
  role_title TEXT NOT NULL,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  notes TEXT,
  applied_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX idx_applications_user ON applications (user_id, applied_at);

CREATE TABLE coach_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  focus TEXT,
  preferred_times TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'requested',
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE hires (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  candidate_name TEXT NOT NULL,
  company TEXT NOT NULL,
  role_title TEXT NOT NULL,
  week_start TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_hires_week ON hires (week_start);

CREATE TABLE live_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  task_prompt TEXT NOT NULL,
  role_label TEXT NOT NULL,
  started_at TEXT,
  charged_seconds INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE TABLE activity (
  user_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  PRIMARY KEY (user_id, usage_date),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX idx_activity_date ON activity (usage_date);

CREATE TABLE deployedx_roles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  track TEXT NOT NULL,
  location TEXT NOT NULL,
  summary TEXT NOT NULL
);
