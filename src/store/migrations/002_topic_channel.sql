-- T6-2: each topic can have its own private Slack channel (DEC-046). Additive only.
ALTER TABLE topics ADD COLUMN slack_channel_id text UNIQUE;
