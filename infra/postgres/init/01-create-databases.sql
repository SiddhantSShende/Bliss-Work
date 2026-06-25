-- Database-per-service (single local Postgres instance).
-- Runs once via the official postgres image entrypoint on first init.
CREATE DATABASE authdb;
CREATE DATABASE taskdb;
CREATE DATABASE messagingdb;
CREATE DATABASE notificationdb;
-- email-worker owns its dedup state (database-per-service; no more co-locating
-- in messagingdb). Email lookups now go through auth-svc's internal API.
CREATE DATABASE emaildb;

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
