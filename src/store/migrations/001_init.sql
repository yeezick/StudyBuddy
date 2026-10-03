-- Records live in Postgres; queues and short-lived quiz state stay in Redis (DEC-047).
-- Shapes follow R7 §4. JSON columns hold the app's objects verbatim so the store can
-- return exactly what it was given; the plain columns are for querying.

CREATE TABLE users (
  id            text PRIMARY KEY,
  slack_user_id text UNIQUE,
  slack_team_id text,
  tz            text,
  settings      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE topics (
  id             text PRIMARY KEY,                -- slug
  owner_user_id  text NOT NULL REFERENCES users(id),
  name           text NOT NULL,
  goal           text,
  target_date    date,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  professor      jsonb,
  sources        jsonb NOT NULL DEFAULT '[]',
  schedule_prefs jsonb,
  unit_labels    jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE concepts (
  id         text PRIMARY KEY,                    -- {topicId}:{localId}
  topic_id   text NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  local_id   text NOT NULL,
  name       text NOT NULL,
  summary    text NOT NULL DEFAULT '',
  unit       text,                                -- scope.module today
  lesson     text,
  tags       text[] NOT NULL DEFAULT '{}',
  provenance jsonb NOT NULL DEFAULT '{}',         -- { sourceIds[], addedBy, addedAt }
  status     text NOT NULL DEFAULT 'active',
  position   integer NOT NULL,                    -- library order
  data       jsonb NOT NULL,                      -- the concept as the app sees it
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (topic_id, local_id)
);
CREATE INDEX concepts_topic_position ON concepts (topic_id, position);

-- Scheduler state, one per user × concept. No FK to concepts: a card can outlive its concept.
CREATE TABLE cards (
  user_id    text NOT NULL REFERENCES users(id),
  concept_id text NOT NULL,
  state      jsonb NOT NULL,                      -- SM-2 today, FSRS fields later
  due        timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, concept_id)
);
CREATE INDEX cards_user_due ON cards (user_id, due);

CREATE TABLE review_events (
  id         bigserial PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id),
  concept_id text NOT NULL,
  topic_id   text,
  ts         timestamptz NOT NULL DEFAULT now(),
  trigger    text,
  quiz_id    text,
  item_type  text,
  correct    boolean,
  score      real,
  confidence smallint,
  latency_ms integer,
  grade      smallint CHECK (grade BETWEEN 1 AND 4),
  prev_state jsonb,
  next_state jsonb
);
CREATE INDEX review_events_user_concept_ts ON review_events (user_id, concept_id, ts);
CREATE INDEX review_events_user_topic_ts ON review_events (user_id, topic_id, ts);

CREATE FUNCTION review_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'review_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER review_events_no_update_delete
  BEFORE UPDATE OR DELETE ON review_events
  FOR EACH ROW EXECUTE FUNCTION review_events_append_only();

CREATE TABLE sessions (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id),
  topic_id     text,
  status       text,
  data         jsonb NOT NULL,
  started_at   timestamptz,
  completed_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_updated ON sessions (user_id, updated_at DESC);

-- Quiz summaries (Redis keeps the last 30; here they are kept).
CREATE TABLE quiz_history (
  id           bigserial PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id),
  quiz_id      text,
  completed_at timestamptz,
  entry        jsonb NOT NULL
);
CREATE INDEX quiz_history_user_id ON quiz_history (user_id, id DESC);

CREATE TABLE mastery_snapshots (
  user_id text NOT NULL REFERENCES users(id),
  day     date NOT NULL,
  record  jsonb NOT NULL,
  PRIMARY KEY (user_id, day)
);
