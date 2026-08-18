# region-bridge

Cross-region event replication over **NATS JetStream**, replacing Kafka
MirrorMaker2 for the WAN hop. Kafka stays the in-region bus and no other service
changes: the bridge is one more consumer of the local log and one more producer
into it.

```
local Kafka ──(export)──► EVENTS_OUT_<region> ──JetStream──► peer regions
local Kafka ◄──(import)── EVENTS_IN_<region>  ◄──sources──── peer regions
```

Read `docs/CROSS-REGION.md` at the repository root for the topology, the
loop-freedom argument, the runbook and the rollback procedure. This file is the
short version for someone changing the code.

## Layout

| Package | What it owns |
|---|---|
| `internal/loop` | Which events may cross a boundary. Pure — the cycle guard. |
| `internal/streams` | The JetStream topology, and the assertion that it cannot loop. |
| `internal/bridge` | The two directions: Kafka→JetStream, JetStream→Kafka. |
| `internal/config` | The deployment contract; every invalid combination fails at startup. |
| `internal/health` | `/healthz` `/readyz` `/status` `/metrics`. |
| `internal/backoff` | Capped exponential backoff with full jitter. |

## The rules this code exists to keep

1. **An event is exported by exactly one region — the one that produced it.**
   Everything about loop prevention follows from that sentence.
2. **Nothing is acknowledged before it has landed on the other side.** Both
   directions are at-least-once, and both rely on downstream dedupe (JetStream's
   message-id window outbound, the platform's `consumed_events` inbound).
3. **Nothing blocks forever.** Every wait has a deadline or a `ctx.Done()`, and
   no lock is held across I/O.
4. **A poison event never stalls a healthy one indefinitely.** After the retry
   budget it is dead-lettered with a reason, and the topic moves on.

## Tests

```
go test ./...          # policy: the cycle guard, the topology, readiness, config
go test -race ./...
```

The tests deliberately cover the decisions rather than the plumbing: a mesh that
loops is not caught by an integration test in staging, it is caught by a WAN
egress bill.
