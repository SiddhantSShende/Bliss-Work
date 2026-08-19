# Call recording

Recording is **off**. This is what it does when it is on, what it costs to turn
on, and what you owe the people in the room.

---

## 1. What it records, and what it never records

| Call kind | Recorded |
| --- | --- |
| Meeting (`/meetings`) | yes |
| Channel call | yes |
| 1:1 call in a chat | **never** |

A one-to-one call is the closest thing this product has to a phone call between
two people, and a deployment-wide switch is the wrong place to decide that those
are taped. The rule lives in `api.startRecording` in messaging-svc, not in
configuration, so it cannot be turned off by an environment variable.

Everyone in a recorded call is told, on the call itself: `CallDTO` carries
`recordingStatus: "RECORDING"` while it runs, and the Meetings card says *"This
call is being recorded"*. In two-party-consent jurisdictions that notice is a
legal requirement rather than a courtesy — check what your own users are owed
before enabling this, and remember that a meeting link can be redeemed by
someone in another organisation entirely.

Recordings are one MP4 per call, stored beside chat attachments — same volume or
bucket, same per-org prefix — so deleting an organisation
(`blob.Store.RemoveOrg`) takes its recordings with it. Nothing expires them
automatically: that is a retention policy you have to add.

## 2. Why it is not just a flag

Recording is done by **LiveKit Egress**, a separate process that joins the room
as a hidden participant, composites it and writes the file. It takes its work
from the SFU **over Redis**.

This deployment's SFU deliberately has no Redis. It runs with host networking
(it needs a 200-port contiguous UDP range), so it cannot resolve `redis` on the
compose bridge, and `infra/livekit/livekit.yaml` says so at length. Enabling
recording is therefore a topology change:

```
livekit-server (host net) ──┐
                            ├── Redis ── livekit-egress (bridge) ── media volume / bucket
messaging-svc (bridge) ─────┘                    │
        ▲                                        │
        └──────── webhook: egress_ended ─────────┘
```

## 3. Turning it on

1. **Storage.** Nothing to do on `MEDIA_BACKEND=s3` — egress uploads to the same
   bucket and prefix. On `fs`, egress writes into the `media_blobs` volume, and
   `RECORDINGS_EGRESS_ROOT` must be the path **the egress container** has it
   mounted at (`docker-compose.recording.yml` uses `/var/lib/blisswork/media`,
   the same as `MEDIA_ROOT`).

2. **`infra/livekit/livekit.yaml`** — uncomment the `redis:` and `webhook:`
   blocks and fill them in. The webhook URL is
   `https://<host>/api/messaging/livekit/webhook` — **not** `/livekit/webhook`,
   which the edge proxies to the SFU itself, so the callback would arrive back
   at LiveKit and the recording would sit in `RECORDING` for ever.
   ⚠️ This file is a single-file bind mount: `docker compose restart livekit` is
   not enough, the container must be **recreated**.

3. **`.env.prod`** — `RECORDINGS_ENABLED=true` (plus `RECORDINGS_EGRESS_ROOT` on
   `fs`). messaging-svc refuses to boot if recording is on and it has nowhere to
   write, which is deliberate: a recording that silently goes nowhere is worse
   than one that never starts.

4. **Bring it up with the overlay**, and with BOTH env files:

   ```
   docker compose --env-file .env --env-file .env.prod \
     -f docker-compose.prod.yml -f docker-compose.recording.yml up -d \
     redis livekit-egress messaging-svc
   ```

   The overlay also publishes Redis on `127.0.0.1:6379` — loopback only,
   because a published Docker port bypasses ufw.

5. **Recreate the SFU** so it picks up the new config:
   `docker compose ... up -d --force-recreate livekit`.

## 4. Checking it works

```
docker compose logs livekit-egress | tail        # "starting egress service"
docker compose logs messaging-svc | grep -i record
```

Start a meeting, then:

```sql
SELECT call_id, status, size_bytes, duration_ms, error
FROM call_recordings ORDER BY started_at DESC LIMIT 5;
```

* `RECORDING` and staying that way after the call ended → the webhook is not
  arriving. Check the URL in `livekit.yaml` first (see the trap above), then
  whether the WAF ate it — the callback goes through Coraza like any other small
  JSON POST, and a 403 in the Caddy log is the tell. The route is deliberately
  outside `/api/v1` and outside the JWT middleware; the signature over the body
  is what authenticates it, and messaging-svc logs `livekit webhook rejected`
  when that check fails.
* `FAILED` with an error → read `error`. `disk full`, a missing `SYS_ADMIN`
  capability (Chrome cannot start) and a wrong bucket all land here.
* `READY` but playback 404s → the key and the storage disagree. On `fs` that is
  almost always `RECORDINGS_EGRESS_ROOT` pointing somewhere egress does not
  actually have the volume; on `s3`, a `MEDIA_S3_PREFIX` mismatch.

## 5. Turning it off

Set `RECORDINGS_ENABLED=false`, recreate messaging-svc, and drop the overlay.
Existing recordings stay playable — playback reads the blob store directly and
needs no egress. Re-comment the `redis:` block in `livekit.yaml` if you also
stop publishing Redis, or livekit-server will fail at startup looking for it.

## 6. Cost

Room composite runs a headless browser plus an encoder per recording — the most
CPU-hungry thing in the stack per unit of work, on the same host as the SFU. The
overlay caps it at 2 CPUs, which is about two concurrent recordings. Beyond
that, recordings queue; size the host before turning this on somewhere busy.
