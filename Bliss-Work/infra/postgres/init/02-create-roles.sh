#!/bin/sh
# Per-service, least-privilege Postgres roles (database-per-service).
#
# Runs once on first init, AFTER 01-create-databases.sql. This REPLACES the old
# 02-create-roles.sql, whose psql `:'VAR'` substitution does NOT resolve under
# the postgres image entrypoint (it runs *.sql via `psql -f` with NO -v vars), so
# role creation failed with a syntax error and every service fell back to the
# `taskboard` superuser — which silently BYPASSES Row-Level Security.
#
# Passwords come from env (*_DB_PASSWORD — set these in prod). Dev-safe fallbacks
# let the local stack create working roles too. They MUST match the per-service
# *_DATABASE_URL values in .env / .env.prod.
#
# Each service gets a login role that can connect to ONLY its own database and
# owns that database's `public` schema (so its migrations work). With these roles
# in use (non-superuser), the per-org RLS policies actually ENFORCE.
set -e

AUTH_PW="${AUTH_DB_PASSWORD:-auth_dev_pw}"
TASK_PW="${TASK_DB_PASSWORD:-task_dev_pw}"
MESSAGING_PW="${MESSAGING_DB_PASSWORD:-messaging_dev_pw}"
NOTIFICATION_PW="${NOTIFICATION_DB_PASSWORD:-notification_dev_pw}"
EMAIL_PW="${EMAIL_DB_PASSWORD:-email_dev_pw}"
INTEGRATIONS_PW="${INTEGRATIONS_DB_PASSWORD:-integrations_dev_pw}"
TELEMETRY_PW="${TELEMETRY_DB_PASSWORD:-telemetry_dev_pw}"
STICKY_PW="${STICKY_DB_PASSWORD:-sticky_dev_pw}"

# Create login roles + revoke the implicit PUBLIC CONNECT so only the owner role
# can reach each database. `:'var'` safely single-quotes the password value.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v auth_pw="$AUTH_PW" -v task_pw="$TASK_PW" -v messaging_pw="$MESSAGING_PW" \
  -v notification_pw="$NOTIFICATION_PW" -v email_pw="$EMAIL_PW" \
  -v integrations_pw="$INTEGRATIONS_PW" -v telemetry_pw="$TELEMETRY_PW" \
  -v sticky_pw="$STICKY_PW" <<'EOSQL'
DROP ROLE IF EXISTS auth_user;
CREATE ROLE auth_user LOGIN PASSWORD :'auth_pw';
REVOKE ALL ON DATABASE authdb FROM PUBLIC;
GRANT CONNECT ON DATABASE authdb TO auth_user;

DROP ROLE IF EXISTS task_user;
CREATE ROLE task_user LOGIN PASSWORD :'task_pw';
REVOKE ALL ON DATABASE taskdb FROM PUBLIC;
GRANT CONNECT ON DATABASE taskdb TO task_user;

DROP ROLE IF EXISTS messaging_user;
CREATE ROLE messaging_user LOGIN PASSWORD :'messaging_pw';
REVOKE ALL ON DATABASE messagingdb FROM PUBLIC;
GRANT CONNECT ON DATABASE messagingdb TO messaging_user;

DROP ROLE IF EXISTS notification_user;
CREATE ROLE notification_user LOGIN PASSWORD :'notification_pw';
REVOKE ALL ON DATABASE notificationdb FROM PUBLIC;
GRANT CONNECT ON DATABASE notificationdb TO notification_user;

DROP ROLE IF EXISTS email_user;
CREATE ROLE email_user LOGIN PASSWORD :'email_pw';
REVOKE ALL ON DATABASE emaildb FROM PUBLIC;
GRANT CONNECT ON DATABASE emaildb TO email_user;

DROP ROLE IF EXISTS integrations_user;
CREATE ROLE integrations_user LOGIN PASSWORD :'integrations_pw';
REVOKE ALL ON DATABASE integrationsdb FROM PUBLIC;
GRANT CONNECT ON DATABASE integrationsdb TO integrations_user;

DROP ROLE IF EXISTS telemetry_user;
CREATE ROLE telemetry_user LOGIN PASSWORD :'telemetry_pw';
REVOKE ALL ON DATABASE telemetrydb FROM PUBLIC;
GRANT CONNECT ON DATABASE telemetrydb TO telemetry_user;

DROP ROLE IF EXISTS sticky_user;
CREATE ROLE sticky_user LOGIN PASSWORD :'sticky_pw';
REVOKE ALL ON DATABASE stickydb FROM PUBLIC;
GRANT CONNECT ON DATABASE stickydb TO sticky_user;
EOSQL

# Each role OWNS its own database's public schema (migrations create tables there).
for pair in "authdb auth_user" "taskdb task_user" "messagingdb messaging_user" \
            "notificationdb notification_user" "emaildb email_user" \
            "integrationsdb integrations_user" "telemetrydb telemetry_user" \
            "stickydb sticky_user"; do
  # shellcheck disable=SC2086
  set -- $pair
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" -d "$1" \
    -c "GRANT ALL ON SCHEMA public TO $2; ALTER SCHEMA public OWNER TO $2;"
done

echo "02-create-roles.sh: per-service least-priv roles created (RLS now enforces)"
