-- Database-per-service (single local Postgres instance).
-- Runs once via the official postgres image entrypoint on first init.
CREATE DATABASE authdb;
CREATE DATABASE taskdb;
CREATE DATABASE messagingdb;
CREATE DATABASE notificationdb;
-- integrations-svc owns external-account connections + encrypted tokens.
CREATE DATABASE integrationsdb;
-- email-worker owns its dedup state (database-per-service; no more co-locating
-- in messagingdb). Email lookups now go through auth-svc's internal API.
CREATE DATABASE emaildb;
-- telemetry-svc owns the member activity record: sessions, the raw event stream
-- (partitioned by day, 90-day retention) and the daily rollups that outlive it.
-- Separate from authdb on purpose: the prune drops millions of rows a night, and
-- that autovacuum churn must not share a database with `users`.
CREATE DATABASE telemetrydb;

-- citext is used for case-insensitive emails/usernames; enable per-db.
\connect authdb
CREATE EXTENSION IF NOT EXISTS citext;
\connect taskdb
CREATE EXTENSION IF NOT EXISTS citext;
\connect messagingdb
CREATE EXTENSION IF NOT EXISTS citext;
\connect notificationdb
CREATE EXTENSION IF NOT EXISTS citext;
\connect emaildb
CREATE EXTENSION IF NOT EXISTS citext;
\connect integrationsdb
CREATE EXTENSION IF NOT EXISTS citext;
\connect telemetrydb
CREATE EXTENSION IF NOT EXISTS citext;
