ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN target_company TEXT;
ALTER TABLE users ADD COLUMN interview_date TEXT;
ALTER TABLE users ADD COLUMN last_weak_spot TEXT;

ALTER TABLE live_sessions ADD COLUMN instructions TEXT;

CREATE TABLE coach_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('voice', 'live')),
  structure INTEGER,
  clarity INTEGER,
  impact INTEGER,
  weak_spot TEXT,
  opening_weak_spot TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, usage_date, channel),
  FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX idx_coach_sessions_user ON coach_sessions (user_id, usage_date);

UPDATE users SET
  display_name = 'Demo Free',
  last_weak_spot = 'a concrete result'
WHERE id = 'user_free';

UPDATE users SET
  display_name = 'Demo Voice',
  target_company = 'Example Grid',
  interview_date = '2026-10-28',
  last_weak_spot = 'asking a discovery question before the pitch'
WHERE id = 'user_voice';

UPDATE users SET
  display_name = 'Demo Live',
  target_company = 'Example Analytics',
  interview_date = '2026-10-30',
  last_weak_spot = 'explaining a failure without jargon'
WHERE id = 'user_live';

UPDATE users SET
  display_name = 'Demo Coach',
  last_weak_spot = 'scoping the first step'
WHERE id = 'user_coach';

INSERT INTO coach_sessions (
  id, user_id, usage_date, channel, structure, clarity, impact, weak_spot, opening_weak_spot, created_at, updated_at
) VALUES
  ('cs_voice', 'user_voice', '2026-10-23', 'voice', 3, 4, 2, 'asking a discovery question before the pitch', 'a concrete result', '2026-10-23T18:00:00.000Z', '2026-10-23T18:10:00.000Z'),
  ('cs_live', 'user_live', '2026-10-23', 'live', 4, 3, 4, 'explaining a failure without jargon', 'scoping the first step', '2026-10-23T18:00:00.000Z', '2026-10-23T18:12:00.000Z'),
  ('cs_coach', 'user_coach', '2026-10-22', 'voice', 3, 3, 3, 'scoping the first step', 'a concrete result', '2026-10-22T18:00:00.000Z', '2026-10-22T18:10:00.000Z');
