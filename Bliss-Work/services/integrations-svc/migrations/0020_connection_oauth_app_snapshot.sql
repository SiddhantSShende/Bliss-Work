-- Keep legacy OAuth connections tied to the app registration that issued
-- their refresh token. New Outlook connections use the centrally managed
-- Microsoft app and leave this column NULL.
ALTER TABLE integration_connections
    ADD COLUMN IF NOT EXISTS oauth_app_credential_id uuid
        REFERENCES provider_app_credentials(id) ON DELETE SET NULL;

UPDATE integration_connections AS c
   SET oauth_app_credential_id = app.id
  FROM provider_app_credentials AS app
 WHERE c.oauth_app_credential_id IS NULL
   AND c.provider IN ('gmail', 'outlook', 'teams')
   AND app.org_id = c.org_id
   AND app.vendor = CASE WHEN c.provider = 'gmail' THEN 'google' ELSE 'microsoft' END;
