CREATE TABLE try_usage (
  ip_hash TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0 CHECK (tries >= 0),
  PRIMARY KEY (ip_hash, usage_date)
);

INSERT INTO tasks (id, role, kind, title, prompt) VALUES
  ('de-1', 'data_engineer', 'interview', 'Wrong on Mondays', 'A dashboard the exec team trusts is wrong every Monday. How do you tell whether it is the pipeline, the metric definition, or the source?'),
  ('de-2', 'data_engineer', 'interview', 'A number you will not defend', 'Tell me about a time a stakeholder asked for a metric you could not defend. What did you change in the model or the warehouse?'),
  ('de-3', 'data_engineer', 'interview', 'The first week of the warehouse', 'Design the first week of a customer-data warehouse for a company with Stripe, the product database, and a messy spreadsheet. What do you refuse to model on day one?'),
  ('de-4', 'data_engineer', 'interview', 'Curated or one-off', 'How do you decide what belongs in the curated layer versus a one-off query? Give the test you use.'),
  ('de-5', 'data_engineer', 'interview', 'The revenue backfill', 'A backfill will rewrite 18 months of revenue. Who do you tell, what do you snapshot, and how do you prove the new number?'),
  ('de-6', 'data_engineer', 'interview', 'Latest versus last quarter', 'Explain slowly changing dimensions to a product manager who wants just the latest row and a finance partner who needs last quarter to stay still.');
