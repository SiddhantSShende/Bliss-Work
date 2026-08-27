#!/usr/bin/env bash
# Nightly k6 capacity gate — one CONST_RPS hold, checked against the measured
# baselines in loadtest/README.md, not just "did k6 finish".
#
# This is A12 in the scaling roadmap: turn "we load-tested it once" into a
# standing tripwire. It reuses step.sh's own docker-invocation and
# --summary-export JSON-parsing pattern (same executor, same k6 image, same
# python3 heredoc style) rather than inventing a second way to drive k6 — see
# step.sh for the RATES-stepping variant this is a single-rate sibling of.
#
# ── What "regressed" means here ──────────────────────────────────────────────
# README Run 2 (task-svc included — the current, authoritative measurement):
# sustainable ≈400rps, knee at 500rps. At 400rps: aggregate p95 139ms, 0.00%
# errors. At 600rps (past the knee): ep_inbox/ep_tasks p95 blow up to
# 5.29s/5.41s while every other endpoint in the mix stays under 350ms — those
# two are what degrades first, and are exactly what this gate watches. RATE
# below sits inside the 400-450rps "meaningful headroom short of the exact
# knee" band the roadmap calls for, not at the knee value itself.
#
# Thresholds are set with headroom on both sides: well above the healthy
# baseline (room for ordinary CI-runner noise) and 6-7x below the broken-at-600
# numbers, so a breach here means a real regression, not noise. Each threshold
# below is commented with the specific README number it's anchored to.
#
# ── Safety ───────────────────────────────────────────────────────────────────
# Built to run against the CI-local docker-compose stack the workflow stands up
# (127.0.0.1 published ports, torn down at the end of the job — see
# .github/workflows/loadtest-gate.yml). It is also safe to run by hand on a box
# that also runs prod, because it carries the exact same guard step.sh does:
# refuse to start if any `*-prod-*` container is unhealthy or load is high.
# Never point LT_* at anything but a stack you own.
set -Eeuo pipefail

cd "$(dirname "$0")"

USERS_FILE="${LT_USERS:-users.json}"
if [ ! -r "$USERS_FILE" ]; then
  echo "LT_USERS=$USERS_FILE is not readable — run ./provision.sh first (see README)" >&2
  exit 1
fi

RATE="${RATE:-420}"
HOLD="${HOLD:-60s}"
ABORT_LOAD="${ABORT_LOAD:-14}"
OUT="${OUT:-results}"
mkdir -p "$OUT"

# README: 0.00% errors at every rate through 600rps (Run 2) — a nonzero rate at
# 420rps, well below the knee, is already new.
MAX_ERROR_RATE="${MAX_ERROR_RATE:-0.01}"
# README: aggregate p95 139ms @400rps sustainable → 2.81s @600rps (broken).
MAX_AGG_P95_MS="${MAX_AGG_P95_MS:-1000}"
# README: ep_inbox p95 5.29s @600rps (broken); this is task-svc's
# /tasks/inbox, the first thing to degrade in the whole mix.
MAX_INBOX_P95_MS="${MAX_INBOX_P95_MS:-800}"
# README: ep_tasks p95 5.41s @600rps (broken) — same endpoint, sampled from a
# different branch of the mix's weighted draw (see blisswork.js), so it moves
# with ep_inbox and gets the same threshold.
MAX_TASKS_P95_MS="${MAX_TASKS_P95_MS:-800}"

prod_unhealthy() {
  sudo -n docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null \
    | grep -- '-prod-' | grep -c 'unhealthy' || true
}
load1() { awk '{print $1}' /proc/loadavg; }

bad=$(prod_unhealthy)
if [ "${bad:-0}" -gt 0 ]; then
  echo "ABORT: $bad production container(s) unhealthy — refusing to load-test this box" >&2
  exit 1
fi
l=$(load1)
if awk -v l="$l" -v m="$ABORT_LOAD" 'BEGIN{exit !(l>m)}'; then
  echo "ABORT: load average ${l} exceeds ${ABORT_LOAD}" >&2
  exit 1
fi

json="$OUT/ci-gate-${RATE}.json"
echo "Running blisswork.js at ${RATE} rps for ${HOLD}..." >&2
# `|| true`: blisswork.js carries its OWN k6 thresholds (http_req_failed,
# http_req_duration p99), so k6 itself exits non-zero when THOSE are breached
# — but the summary JSON is written regardless, and OUR thresholds below (set
# from loadtest/README.md, not k6's generic ones) are the actual gate. Let a
# k6-level threshold failure fall through to the python check instead of
# aborting the script here via pipefail, so the failure is always reported
# with a specific metric/threshold rather than a bare non-zero exit.
sudo -n docker run --rm --network host \
  -v "$PWD/k6:/scripts:ro" -v "$PWD/$OUT:/out" \
  -v "$PWD/$USERS_FILE:/users.json:ro" -e LT_USERS=/users.json \
  -e CONST_RPS="$RATE" -e HOLD="$HOLD" \
  grafana/k6:latest run --quiet --summary-export="/out/ci-gate-${RATE}.json" \
  /scripts/blisswork.js 2>&1 | tee "$OUT/ci-gate-${RATE}.log" || true

if [ ! -s "$json" ]; then
  echo "no k6 summary written — see $OUT/ci-gate-${RATE}.log" >&2
  exit 1
fi

python3 - "$json" "$MAX_ERROR_RATE" "$MAX_AGG_P95_MS" "$MAX_INBOX_P95_MS" "$MAX_TASKS_P95_MS" <<'PY'
import json, sys

path, max_err, max_agg_p95, max_inbox_p95, max_tasks_p95 = sys.argv[1:6]
max_err = float(max_err)
max_agg_p95 = float(max_agg_p95)
max_inbox_p95 = float(max_inbox_p95)
max_tasks_p95 = float(max_tasks_p95)

d = json.load(open(path))
m = d.get("metrics", {})

def p95(metric_name):
    metric = m.get(metric_name)
    if not metric:
        return None
    return metric.get("p(95)")

err_rate = m.get("http_req_failed", {}).get("value")
agg_p95 = p95("http_req_duration")
inbox_p95 = p95("ep_inbox")
tasks_p95 = p95("ep_tasks")
reqs = m.get("http_reqs", {}).get("count", 0)

print(f"\n{'metric':<22} {'value':>12} {'threshold':>12}  result")
print("-" * 62)

checks = [
    ("error rate", err_rate, max_err, "{:.4f}", "<="),
    ("agg p95 (ms)", agg_p95, max_agg_p95, "{:.1f}", "<="),
    ("ep_inbox p95 (ms)", inbox_p95, max_inbox_p95, "{:.1f}", "<="),
    ("ep_tasks p95 (ms)", tasks_p95, max_tasks_p95, "{:.1f}", "<="),
]

breaches = []
for name, value, limit, fmt, op in checks:
    if value is None:
        print(f"{name:<22} {'MISSING':>12} {limit:>12.4f}  FAIL (metric absent from summary)")
        breaches.append(f"{name}: metric missing from k6 summary — check {path}")
        continue
    ok = value <= limit
    mark = "PASS" if ok else "FAIL"
    print(f"{name:<22} {fmt.format(value):>12} {limit:>12.4f}  {mark}")
    if not ok:
        breaches.append(f"{name} = {fmt.format(value)} exceeds threshold {limit} ({op} required)")

print(f"\n{int(reqs)} requests sent.")

if breaches:
    print("\nCAPACITY GATE FAILED — breached threshold(s):")
    for b in breaches:
        print(f"  - {b}")
    print(
        "\nThis means p95 latency or the error rate regressed past what "
        "loadtest/README.md documents as healthy at this rate. Compare against "
        "the Run 2 table there, and re-run loadtest/step.sh locally to draw a "
        "fresh throughput/latency curve before concluding this is a real "
        "capacity regression rather than CI-runner noise."
    )
    sys.exit(1)

print("\nCAPACITY GATE OK — within documented baselines.")
PY
