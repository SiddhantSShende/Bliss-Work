# UI translation (translate-gw) — architecture and Google credential handoff

```
Web / Electron → packages/app i18n → auth-svc  /i18n/{languages,catalog}   (user session checked here)
                                   → translate-gw (Go)  /v1/{languages,catalog}  (X-Internal-Token)
                                   → Google Cloud Translation (Basic v2), authenticated by ADC
```

* The app bundles English only. Every other locale is a catalog translated from the
  English files in `packages/app/src/i18n/locales/en/`, cached (Redis via `REDIS_URL`,
  in-process if unset) and fetched on demand. Missing keys fall back to English.
* `I18N_LOCALES` (translate-gw env, default `en,es,fr,de,hi,pt,ja,zh,ko`) is the only
  list of languages; it is intersected with what Google supports at run time. `zh`
  and `pt` stay BlissWork's public codes even if Google spells them `zh-CN` / `pt-BR`.
* **auth-svc holds no Google credential and no translation logic.** translate-gw is
  internal only: no published port, no Caddy route, every `/v1/*` call needs
  `TRANSLATE_INTERNAL_TOKEN`.
* translate-gw uses the official Go client with Application Default Credentials. The
  library obtains **and refreshes** access tokens itself. No API key, no pasted
  token, no downloaded service-account key.
* Without a credential everything still starts: `/i18n/languages` returns `[]` (the
  switcher shows English only) and `/i18n/catalog` returns 503.

## Where the credential goes (the one configuration point)

| Variable (in `.env.prod`) | Meaning | Default |
|---|---|---|
| `TRANSLATE_ADC_DIR` | host directory, mounted **read-only** at `/run/adc` | `./keys/translate-adc` |
| `TRANSLATE_GOOGLE_CREDENTIALS` | credential file path **inside** the container; set **empty** to use the GCE/GKE/Cloud Run metadata server instead | `/run/adc/credentials.json` |

Put the credential at `${TRANSLATE_ADC_DIR}/credentials.json`, readable by uid 10001
(`chown 10001 … && chmod 400 …`). If the config references a token file, put that file
in the same directory. The directory is git-ignored (`keys/translate-adc/`).

## What the GCP administrator provides

* A Google Cloud project with **Cloud Translation API** enabled.
* A service account with **`roles/cloudtranslate.user`**.
* **Workload Identity Federation** (recommended: no long-lived secret): a workload
  identity pool + provider trusting the company's identity source, with the service
  account allowed to be impersonated by it. They export the config with
  `gcloud iam workload-identity-pools create-cred-config … --output-file=credentials.json`
  (and the subject-token file it references, if file-sourced).
* If the gateway runs on Google Cloud itself, nothing to mount: attach the service
  account to the workload and set `TRANSLATE_GOOGLE_CREDENTIALS=` (empty).

## Enable, verify, roll back

```
docker compose --env-file .env --env-file .env.prod -f docker-compose.prod.yml --profile i18n \
    up -d --build translate-gw
docker compose --env-file .env --env-file .env.prod -f docker-compose.prod.yml exec translate-gw \
    sh -c 'wget -qO- --header "X-Internal-Token: $TRANSLATE_INTERNAL_TOKEN" http://localhost:8012/v1/languages || echo "NOT WORKING (no/invalid credential): see: docker logs"'
# ^ credential verified = it prints {"languages":[{"code":"es","name":"Spanish"},…8 entries incl. zh, pt…]}
# stop it (auth-svc degrades to English-only; nothing else is affected)
docker compose --env-file .env --env-file .env.prod -f docker-compose.prod.yml --profile i18n stop translate-gw
```

`translate-gw` is intentionally **not** in the Makefile `DEPLOY_*` lists: those lists
also drive rollback, which would then ask an older SHA for a service it never had. A
hand-started profiled service survives `make prod-deploy` / rollback. Start the gateway
before (or with) the auth-svc build that contains `app/routes/i18n_proxy.py`; the proxy
itself needs only `TRANSLATE_GW_URL` and `TRANSLATE_INTERNAL_TOKEN`, already in `.env.prod`.
