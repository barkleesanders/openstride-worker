CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX plans_created ON plans(created_at DESC,id);
CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX activities_date ON activities(date DESC,id);
CREATE TABLE connection (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
