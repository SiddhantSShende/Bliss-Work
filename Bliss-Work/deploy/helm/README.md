# Task-Board Helm chart

Cloud-agnostic Helm chart that deploys the six Task-Board application services to
any conformant Kubernetes cluster (EKS / GKE / AKS / on-prem / kind):

| Service            | Lang        | Port | HTTP | Notes                                          |
| ------------------ | ----------- | ---- | ---- | ---------------------------------------------- |
| `auth-svc`         | FastAPI     | 8001 | yes  | issues JWTs, publishes JWKS, mounts signing keys |
| `task-svc`         | FastAPI     | 8002 | yes  |                                                |
| `notification-svc` | Go          | 8003 | yes  |                                                |
| `messaging-svc`    | Go          | 8004 | yes  |                                                |
| `ws-gateway`       | Go          | 8080 | yes  | WebSocket fan-out; sticky sessions             |
| `email-worker`     | FastAPI     | —    | no   | pure Kafka consumer; no Service/Ingress/HPA/PDB |

Chart path: `deploy/helm/taskboard`.

## What this chart does and does NOT include

This chart deploys ONLY the stateless application tier. The stateful backing
services are assumed to be provided **externally**:

- **Postgres** (database-per-service: `authdb`, `taskdb`, `messagingdb`,
  `notificationdb`, `emaildb`) — a managed instance (RDS / Cloud SQL / Azure DB)
  or an in-cluster operator (CloudNativePG, Zalando, Crunchy).
- **Redis** — ElastiCache / Memorystore / Azure Cache, or the Redis/Valkey
  operator. Used by `ws-gateway` (presence) and `email-worker` (offline check).
- **Kafka** — MSK / Confluent Cloud / Redpanda Cloud, or Strimzi in-cluster.

You wire these in through `values.yaml`:

- Connection **URLs** (one `*_DATABASE_URL` per service, `REDIS_URL`) live in the
  `secrets` map (rendered to a Secret) — or an external Secret (see below).
- Broker list (`KAFKA_BROKERS`) and other non-secret config live in the `env`
  map (rendered to a ConfigMap).

## Prerequisites

- Kubernetes 1.25+ (uses `autoscaling/v2`, `policy/v1`, `networking.k8s.io/v1`).
- Helm 3.8+.
- For the optional pieces:
  - **Ingress**: an ingress controller (defaults assume ingress-nginx).
  - **TLS**: [cert-manager](https://cert-manager.io/) with a `ClusterIssuer`
    named in `ingress.clusterIssuer`.
  - **HPA**: metrics-server (CPU). Custom/p99 metrics need the Prometheus Adapter.
  - **NetworkPolicy**: a CNI that enforces it (Calico, Cilium, Antrea).

## Quick start

```sh
# Render locally to inspect (no cluster needed):
helm template taskboard ./taskboard -n taskboard

# Lint:
helm lint ./taskboard

# Install / upgrade:
helm upgrade --install taskboard ./taskboard \
  -n taskboard --create-namespace \
  -f my-values.yaml
```

Minimal `my-values.yaml` for a real environment:

```yaml
global:
  image:
    registry: ghcr.io/your-org/task-board
    tag: "1.4.2"

env:
  KAFKA_BROKERS: "b-1.msk.amazonaws.com:9092,b-2.msk.amazonaws.com:9092"
  WEB_ORIGIN: "https://app.acme.com"
  INVITE_BASE_URL: "https://app.acme.com/invite"
  WEB_BASE_URL: "https://app.acme.com"

ingress:
  host: app.acme.com
  clusterIssuer: letsencrypt-prod

# Prefer an external Secret — see below. For a throwaway cluster you may inline:
secrets:
  AUTH_DATABASE_URL: "postgresql://user:pw@pg-host:5432/authdb"
  # ... etc
```

## Secrets — do NOT ship plaintext in production

The `secrets` map and `signingKeys.data` in `values.yaml` exist so the chart
renders and for throwaway dev clusters **only**. For production, manage secrets
outside the chart and point the chart at them:

1. **External Secrets Operator** (recommended): sync from AWS/GCP Secrets
   Manager, Vault, etc. into a Kubernetes Secret, then set:

   ```yaml
   existingSecret: taskboard-env       # ESO-managed Secret (env vars)
   signingKeys:
     existingKeysSecret: taskboard-keys # ESO-managed Secret (Ed25519 PEMs)
   ```

   When `existingSecret` is set the chart skips rendering its own Secret; the
   external one must contain every key the services read (the keys listed under
   `secrets:` in `values.yaml`).

2. **sealed-secrets**: commit an encrypted `SealedSecret`; the controller
   decrypts it into the Secret named by `existingSecret`.

3. **CSI secrets-store driver**: mount provider secrets and sync to a Secret.

The `auth-svc` Ed25519 signing keys follow the same pattern via
`signingKeys.existingKeysSecret`; the Secret must contain `ed25519_private.pem`
and `ed25519_public.pem`.

## Wiring managed services / operators

- **Postgres via operator (CloudNativePG)**: install the operator + a `Cluster`,
  create the five databases, then set each `*_DATABASE_URL` to the cluster's
  read-write Service. Optionally enable the bundled PgBouncer (below) or use the
  operator's own pooler.
- **Kafka via Strimzi**: install the operator + a `Kafka` CR, then set
  `env.KAFKA_BROKERS` to `<cluster>-kafka-bootstrap:9092`.
- **Redis via operator**: set `secrets.REDIS_URL` to the operator's Service DNS.

### PgBouncer (optional connection pooler)

Autoscaled stateless pods can exhaust a managed Postgres `max_connections`.
Enable the bundled transaction-mode PgBouncer to bound that:

```yaml
pgbouncer:
  enabled: true
  upstream:
    host: my-postgres.internal
    port: 5432
```

Then point the `*_DATABASE_URL` hosts in `secrets` at
`<release>-pgbouncer:6432`. Transaction pooling disables session-scoped DB
features; the services use short request-scoped transactions, which is the
supported pattern.

## ws-gateway sticky sessions

WebSocket connections are long-lived and stateful per pod. The chart sets
`sessionAffinity: ClientIP` on the `ws-gateway` Service and cookie affinity +
long proxy timeouts on the Ingress. ClientIP affinity is a coarse fallback that
breaks for clients behind a shared NAT/egress IP — the **preferred** approach is
an L7 consistent hash on the authenticated `userId` at the ingress or service
mesh (e.g. nginx `hash`, Envoy ring-hash). See `templates/service.yaml` and
`templates/ingress.yaml`.

## Rendered objects (per `helm template`)

- `Deployment` ×6 (one per service; non-root, dropped caps, read-only rootfs,
  liveness/readiness/startup probes on HTTP services, topology spread across
  zones + nodes).
- `Service` ×5 (HTTP services only; ClusterIP; `ws-gateway` sticky).
- `HorizontalPodAutoscaler` ×5 (HTTP services with `hpa.enabled`; CPU; p99
  example commented).
- `Ingress` ×1 (path fan-out, cert-manager TLS).
- `PodDisruptionBudget` ×5 (HTTP services).
- `ConfigMap` ×1 + `Secret` ×1–2 (env + signing keys; skipped when external).
- `NetworkPolicy` ×3 (default-deny ingress, allow intra-namespace, allow DNS).
- `Deployment` + `Service` for PgBouncer (only when `pgbouncer.enabled`).
