-- SIMARSIP D1 schema. Record payloads remain JSON during the first migration
-- so existing API shapes stay compatible; indexed columns support scoped reads.
CREATE TABLE IF NOT EXISTS records (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  username TEXT,
  owner_role TEXT,
  class_name TEXT,
  task_id TEXT,
  status TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (collection, id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_records_collection_owner_user
  ON records (collection, owner_role, username);
CREATE INDEX IF NOT EXISTS idx_records_collection_username
  ON records (collection, username);
CREATE INDEX IF NOT EXISTS idx_records_collection_class
  ON records (collection, class_name);
CREATE INDEX IF NOT EXISTS idx_records_collection_task
  ON records (collection, task_id);
CREATE INDEX IF NOT EXISTS idx_records_collection_created
  ON records (collection, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_username_unique
  ON records (username) WHERE collection = 'students' AND username IS NOT NULL;

-- A separate schema version makes later normalized-table migrations explicit.
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
INSERT OR IGNORE INTO app_meta (key, value) VALUES ('schema_version', '1');
