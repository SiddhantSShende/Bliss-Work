# Observability — Security & Reliability Alerts

Prometheus alert rules that fire on the HTTP metrics every service already
exposes, routed through Alertmanager. This is the SecOps alerting layer on top
of the opt-in observability stack. For the threat model and controls, see
[SECURITY.md](SECURITY.md) and [THREAT_MODEL.md](THREAT_MODEL.md) — this doc
does not repeat them; it covers only the alerting wiring.

## Where things live

| Thing | Path |
| --- | --- |
| Prometheus scrape + `rule_files` + `alerting` | `infra/observability/prometheus.yml` |
| Alert rules | `infra/observability/prometheus/rules/security.yml` |
| Alertmanager config | `infra/observability/alertmanager/alertmanager.yml` |
| Compose services (`prometheus`, `alertmanager`, …) | `docker-compose.yml`, profile `observability` |

## Running it

The whole stack is opt-in behind the `observability` profile:

```bash
docker compose --profile observability up -d
# Prometheus  http://localhost:9091   (Status > Rules, Alerts tabs)
# Alertmanager http://localhost:9093
# Grafana     http://localhost:3000   (anonymous admin)
```

Reload rules after editing without a restart:

```bash
docker compose --profile observability exec prometheus kill -HUP 1
# or: curl -X POST http://localhost:9091/-/reload   (needs --web.enable-lifecycle)
```

## The alerts

| Alert | Fires when | Severity |
| --- | --- | --- |
| `AuthCredentialStuffingBurst` | auth-svc rejects >1 req/s (4xx) on `/auth/login` or `/auth/refresh` for 2m | warning |
| `AuthCredentialStuffingHigh` | same, >10 req/s for 1m (active attack) | critical |
| `RateLimitRejectionsSpike` | a Go service returns >1 req/s of HTTP 429 for 2m | warning |
| `ServiceHigh5xxErrorRate` | a service's 5xx ratio > 5% for 5m | warning |
| `ServiceCritical5xxErrorRate` | a service's 5xx ratio > 20% for 2m | critical |
| `CoreServiceDown` | `up == 0` for auth-/messaging-/task-svc for 1m | critical |

## Metric-label reality (why the rules look the way they do)

The two service families label `http_requests_total` **differently**. The rules
match what is actually emitted (verified against a live `/metrics`, not guessed):

- **Python services (auth-svc, task-svc)** — `prometheus-fastapi-instrumentator`
  7.0.0 with its default `Instrumentator()`. Labels: `handler`, `method`,
  `status`. **`status` is a class string `2xx`/`4xx`/`5xx`, not the exact code.**
  A 401 and a 429 both land in `4xx`. That is why the auth brute-force alert
  keys on the `4xx` class scoped to the login/refresh handlers rather than on a
  literal `status="401"`.
- **Go services (messaging-svc, notification-svc, ws-gateway)** — hand-rolled
  collector. Labels: `method`, `path`, `status`, where **`status` is the exact
  numeric code** (`"401"`, `"429"`, `"500"`). The 429 rate-limit alert relies
  on this.
- Prometheus adds `job="<service>"` from `scrape_configs`; the rules aggregate
  by `job`.

### Making the auth 401 alert code-exact (optional, requires a code change)

To distinguish 401 from 429/404 on auth-svc, disable status grouping in the
service:

```python
# services/auth-svc/app/main.py
Instrumentator(should_group_status_codes=False).instrument(app).expose(app, include_in_schema=False)
```

Then the `status` label becomes the exact code and you can tighten the rule to
`status="401"`. This is a service-code change (out of scope for the dev-safe
alerting phase), so the shipped rule uses the `4xx` class.

## Alertmanager routing

`alertmanager.yml` ships a **dev default**: every alert goes to one webhook
receiver pointed at an in-network sink so the send always succeeds locally
without external credentials. It also defines an inhibit rule so a firing
`critical` suppresses the sibling `warning` for the same `alertname`/`job`.

**Production receivers** are stubbed (commented) in `alertmanager.yml`:

- **Slack** — `slack_configs` with an incoming-webhook `api_url` (inject via a
  secret/file, not inline), one channel per `category`/`severity` route.
- **PagerDuty** — `pagerduty_configs` with a `routing_key`, mapping
  `severity` → PD urgency, for the `critical` route.
- **Email** — `email_configs` with an SMTP smarthost.

Add severity/category branches under `route.routes` (see the commented block) so
`critical` pages PagerDuty while `category=security` also copies a SecOps Slack
channel.

## Extending

1. Add a rule to a group in `security.yml` (or a new `*.yml` in the same
   `rules/` dir — the glob picks it up). Always confirm the label set against a
   real scrape first; Python `status` is grouped, Go `status` is exact.
2. Validate: `promtool check rules infra/observability/prometheus/rules/security.yml`
   (the `prom/prometheus` image bundles `promtool`).
3. Reload Prometheus (see above) and watch **Status > Rules**.
4. For a new receiver, add it under `receivers:` and a matching `route` branch.
