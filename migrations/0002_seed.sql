INSERT INTO users (
  id, email, target_role, tier, first_pick, streak_count, streak_last_date, headline, created_at, updated_at
) VALUES
  ('user_free', 'free@example.com', 'fde', 'free', 0, 2, '2026-10-23', 'Forward deployed engineer who stays through go-live.', '2026-10-18T15:00:00.000Z', '2026-10-23T15:00:00.000Z'),
  ('user_voice', 'voice@example.com', 'solutions_architect', 'voice', 0, 4, '2026-10-23', 'Solutions architect for the first year of a platform deal.', '2026-10-12T15:00:00.000Z', '2026-10-23T15:00:00.000Z'),
  ('user_live', 'live@example.com', 'ai_engineer', 'live', 0, 9, '2026-10-23', 'AI engineer. I ship the eval with the model.', '2026-10-08T15:00:00.000Z', '2026-10-23T15:00:00.000Z'),
  ('user_coach', 'coach@example.com', 'fde', 'coach', 1, 3, '2026-10-22', 'Forward deployed engineer, customer-first.', '2026-10-15T15:00:00.000Z', '2026-10-22T15:00:00.000Z');

INSERT INTO tasks (id, role, kind, title, prompt) VALUES
  ('fde-1', 'fde', 'interview', 'The integration does not work', 'A customer says the integration "does not work." What do you ask in the first five minutes, and what do you refuse to guess?'),
  ('fde-2', 'fde', 'interview', 'Production, on their network', 'Tell me about a time you debugged a production issue on a customer system you did not control. How did you keep the relationship while you were still wrong?'),
  ('fde-3', 'fde', 'interview', 'One tenant, no blast radius', 'How would you roll a risky change out to a single enterprise tenant without exposing the rest of the fleet?'),
  ('fde-4', 'fde', 'interview', 'The go-live date', 'Describe a time you cut scope to hit a go-live date. What did you trade, who agreed, and what did you write down?'),
  ('fde-5', 'fde', 'action', 'Deployment note', 'Write a five-line deployment note a customer engineer could follow without you on the call. Use a real system you know.'),
  ('fde-6', 'fde', 'action', 'Follow-up proof', 'List three proof points you would put in the follow-up email after a technical onsite. Each one should be something the buyer can forward.'),
  ('ai-1', 'ai_engineer', 'interview', 'Where quality is measured', 'Design a retrieval pipeline for a support bot. Where do you measure quality, and what number would make you stop a launch?'),
  ('ai-2', 'ai_engineer', 'interview', 'Wrong in production', 'Tell me about a model you shipped that was wrong in production. What did users hit, and what did you change first?'),
  ('ai-3', 'ai_engineer', 'interview', 'Fine-tune or prompt', 'How do you decide between fine-tuning and prompting? Give the evidence you would want before you spend the week.'),
  ('ai-4', 'ai_engineer', 'interview', 'The agent that emails', 'A product manager wants an agent that emails customers. What guardrails do you insist on before the first send?'),
  ('ai-5', 'ai_engineer', 'action', 'Eight eval cases', 'Draft an eval set of eight cases for a "summarize this ticket" feature. Include at least two cases the model should refuse or escalate.'),
  ('ai-6', 'ai_engineer', 'interview', 'Under a second', 'Explain the latency and quality trade for a voice agent that has to respond in under a second. What do you cut first?'),
  ('sa-1', 'solutions_architect', 'interview', 'The security review', 'Walk a security review board through how tenant data is isolated. Speak as if the board is tired and one person is hostile.'),
  ('sa-2', 'solutions_architect', 'interview', 'The first integration', 'A prospect has a CRM, a warehouse, and a twelve-person IT team. Sketch the first integration you would actually sign up to deliver.'),
  ('sa-3', 'solutions_architect', 'interview', 'Saved by the architecture', 'Tell me about a deal you saved by changing the architecture, not the price. What was the buyer afraid of?'),
  ('sa-4', 'solutions_architect', 'action', 'Mutual action plan', 'Write a one-paragraph mutual action plan for a proof of concept that has stalled for two weeks.'),
  ('sa-5', 'solutions_architect', 'interview', 'The feature you will not build', 'How do you handle a champion who wants a feature your platform will not build? What do you offer instead?'),
  ('sa-6', 'solutions_architect', 'interview', 'The bank asks for single-tenant', 'A bank asks for a single-tenant deployment. Compare that with your multi-tenant default, including what you would not promise.');

INSERT INTO deployedx_roles (id, title, track, location, summary) VALUES
  ('dx-fde', 'Forward Deployed Engineer', 'fde', 'Remote, US hours', 'Sample seat. Embed with one customer, ship the integration, and stay through the first month in production.'),
  ('dx-ai', 'AI Engineer', 'ai_engineer', 'Remote, US hours', 'Sample seat. Own the model path from eval set to the first production incident.'),
  ('dx-sa', 'Solutions Architect', 'solutions_architect', 'Remote, US hours', 'Sample seat. Run the technical win, the security review, and the mutual action plan.');

INSERT INTO daily_usage (user_id, usage_date, text_seconds, voice_seconds, live_seconds) VALUES
  ('user_free', '2026-10-24', 240, 0, 0),
  ('user_voice', '2026-10-24', 300, 360, 0),
  ('user_live', '2026-10-24', 180, 0, 540),
  ('user_coach', '2026-10-23', 600, 0, 300);

INSERT INTO activity (user_id, usage_date) VALUES
  ('user_free', '2026-10-24'),
  ('user_voice', '2026-10-24'),
  ('user_live', '2026-10-24'),
  ('user_coach', '2026-10-23');

INSERT INTO applications (id, user_id, company, role_title, url, status, notes, applied_at) VALUES
  ('app_live_1', 'user_live', 'Example Analytics', 'AI Engineer', 'https://example.com/jobs/analytics', 'interview', 'Demo row. Recruiter screen is booked.', '2026-10-22T18:00:00.000Z'),
  ('app_live_2', 'user_live', 'Example Grid', 'Applied AI Engineer', NULL, 'sent', 'Demo row. Sent the eval write-up with the resume.', '2026-10-24T16:00:00.000Z');

INSERT INTO hires (id, user_id, candidate_name, company, role_title, week_start, notes, created_at) VALUES
  ('hire_demo_1', 'user_live', 'Demo Candidate', 'Example Analytics', 'AI Engineer', '2026-10-19', 'Demo hire, logged by hand. Not a real person.', '2026-10-24T17:00:00.000Z');

INSERT INTO coach_requests (id, user_id, focus, preferred_times, notes, status, created_at) VALUES
  ('coach_demo_1', 'user_coach', 'Forward deployed story', 'Tue or Thu morning', 'Demo request. Wants a harder production-incident story.', 'requested', '2026-10-22T19:00:00.000Z');
