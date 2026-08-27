# Search vs. per-org envelope encryption — a deliberate decision, recorded early

## Why this document exists

No service in this platform can offer full-text search over user content —
task titles, message bodies, mail subjects/bodies — today, and none is close
to being able to. This is not an oversight to fix; it's a direct, structural
consequence of how encryption is designed (`services/shared/crypto/crypto.py`,
ported faithfully to Go at `services/messaging-svc/internal/crypto/crypto.go`).
This document writes that constraint down **before** product pressure to ship
"search my tasks" or "search this channel" arrives under time pressure, so the
tradeoff gets made deliberately instead of by whoever is on call when it comes
up.

## The constraint

Every sensitive field (task titles, message bodies, thread subjects, mail
content, attachment filenames, OAuth tokens, and more) is encrypted with
per-org envelope encryption: a 32-byte DEK per org, wrapped by a KEK (Argon2id
passphrase in dev, Vault Transit in prod), AES-256-GCM, AAD bound to `org_id`.
Ciphertext is opaque to Postgres — there is nothing for `LIKE`, `ILIKE`,
`to_tsvector`, or a `pg_trgm` index to operate on. A repo-wide grep for
`GIN|pg_trgm|to_tsvector` across every `*/migrations/*.sql` file returns zero
hits, consistent with this design: nobody has bolted a search index onto
encrypted columns, because doing so naively would mean storing plaintext (or
something plaintext-equivalent) somewhere, which defeats part of the point of
encrypting the column in the first place.

A **blind index** primitive already exists for exact-match equality lookups
(`Cryptor.blind_index()` in `crypto.py` — `HMAC-SHA256(static_key, lower(strip(value)))`,
stored alongside the ciphertext, e.g. `identities.email_bidx` in auth-svc,
matched via `WHERE email_bidx = :b` in `service.py`). This is how login-by-email
and OAuth-identity lookups work today without decrypting every row. **task-svc
deliberately does not use it for titles** — `app/config.py` says so explicitly:
"task-svc doesn't use the blind index today." The only title-equality lookup
that exists (`DELETE /internal/tasks/by-title/{title}`,
`app/routes/tasks_write.py`) works by decrypting a capped set of candidate rows
in application code and comparing — internal-tooling-only, not a user-facing
feature, capped at 100 rows so it can't degrade into a full-org scan.

**A blind index only ever gives you exact match.** It cannot support substring
search, prefix search, fuzzy match, or relevance ranking — the properties
anyone actually means when they ask for "search."

## The three real options, if/when this is needed

1. **Stay out of scope, permanently.** Users search by other means (filters,
   recency, assignee, channel) and free-text search is explicitly not offered
   for encrypted content. Zero new attack surface, zero new infrastructure,
   and it's an honest answer rather than a degraded one.
2. **Exact-match blind index, extended to titles/subjects.** Cheap (the
   primitive already exists and is proven in auth-svc/integrations-svc), but
   only ever answers "does a task titled exactly this exist," not "find tasks
   about X." Close to useless for the product experience people mean by
   "search."
3. **A separate, plaintext-holding search index** (e.g. a dedicated
   Postgres `tsvector` column outside the encrypted table, OpenSearch/
   Elasticsearch, or similar) fed by a pipeline that decrypts once at write
   time. This is the only option that delivers real search — and it is a
   materially larger security decision, not just an engineering one: it means
   a second place plaintext content lives, with its own access control, its
   own backup/retention posture (see `docs/COMPLIANCE.md` and Part B.12 of the
   scaling roadmap — org data currently has no retention policy at all while
   active, and a search index would inherit that same unbounded-growth
   problem unless designed against it from day one), and its own blast radius
   if compromised. It should not be adopted implicitly by a feature team
   trying to ship a search box; it needs the same sign-off as any other
   decision to hold plaintext user content outside the primary encrypted
   store.

## Where this stands today

**No decision has been made to build search.** This document exists so that
when the question comes up, it's answered by picking deliberately from the
three options above — informed by the real tradeoff — rather than by
whoever's implementing the feature discovering the constraint mid-sprint and
improvising around it. If a decision is made, replace this section with the
chosen option, the reasoning, and a link to the implementation.
