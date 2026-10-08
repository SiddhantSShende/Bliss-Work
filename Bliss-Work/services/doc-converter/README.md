# doc-converter — the Office Document Sandbox

The **only** place in BlissWork that opens a DOC, DOCX, XLS, XLSX, PPT or PPTX
file. Office files are hostile input: they are converted here, in an isolated
LibreOffice container, into a preview artifact, and nothing else crosses back.
No service and no client ever opens, parses or renders one
(`node scripts/check-no-office-readers.mjs` enforces that).

```
attachment bytes ──► messaging-svc ──► POST /convert?kind=docx ──► doc-converter
 (stored as-is)      (authorizes,       raw body in                 (LibreOffice,
                      checks ext +                                   no network)
                      magic bytes)  ◄── artifact + 2 headers ◄──────
                         │
                         ▼ cached beside the original blob (blobs/{org}/ab/cd/{sha}.v1.pdf|json)
```

| Input | Artifact | Content-Type |
|---|---|---|
| doc, docx, ppt, pptx | the document as a PDF | `application/pdf` |
| xls, xlsx | `{"sheets":[{"name","csv","totalRows","truncated"}],"moreSheets"}` — each sheet's cell text **as displayed**; rows/cols capped | `application/json` |

`POST /convert?kind=<doc|docx|xls|xlsx|ppt|pptx>`, body = the raw file,
`Content-Length` required. `GET /healthz`. Success sets `X-Preview-Kind` and
`X-Preview-Duration-Ms`. Failure is `{"code": …}` from a closed set —
`unsupported` 415, `too_large` 413, `unconvertible`/`limit`/`timeout` 422,
`busy` 503, `internal` 500 — and never contains LibreOffice output, a path, a
filename or any document text.

## What makes it a sandbox

Each is a requirement with a test (see below), not a hope:

- **Own network, no way out.** `converter` is an `internal: true` Docker network;
  only messaging-svc also joins it. No published port, no DNS, no route to the
  internet, the host, Postgres or Kafka.
- **No secrets.** It does not use `x-svc-defaults`, so it gets no `env_file`
  (`.env.prod` holds the database URLs and signing secrets) and no CA mount.
- **Non-root (10001), read-only filesystem, all capabilities dropped,** memory /
  CPU / pids limits, and a size-capped tmpfs for the only writable path.
- **Per job:** a fresh 0700 workspace, a fresh LibreOffice profile (macros, Java
  and link updates disabled — `profile-template/`), a **pinned import filter**
  (so LibreOffice never auto-detects a different importer from hostile bytes),
  rlimits (CPU, files, file size), a wall-clock timeout that kills the whole
  process group, and the workspace is **wiped before the reply is sent**.
- **Checked before LibreOffice starts:** magic bytes (OLE vs ZIP) must match the
  kind; ZIPs are read from the central directory only and rejected on total size,
  ratio or entry count (zip bombs); encrypted entries are refused.
- **Checked after:** a PDF must start with `%PDF-`, the sheets artifact must be
  valid JSON of the expected shape, both under the output cap.
- **No LibreOffice script engine is installed** (`--no-install-recommends`: no
  Java, no Python/JS/BeanShell providers).

`RLIMIT_NPROC` is deliberately **not** used: it counts per host UID and every
BlissWork service runs as 10001, so other services' threads ate its budget and
LibreOffice died with "Cannot fork" (found by the measurement run). The compose
`pids` limit is the per-container bound.

## Limits (measured, 2026-10-07)

These are safety ceilings; none hides the Open button (a document that trips one
falls back to Download). Host: 8 CPUs, container limited to 2.

| Fixture | In | Wall | CPU | Peak mem | Out |
|---|---|---|---|---|---|
| one-page docx/doc/pptx/ppt/xls/xlsx | <10 KB | 1.8–2.2 s | 1.7–2.1 s | ~174 MB | <25 KB |
| 200-page DOCX / DOC | 52 KB / 8 MB | 15.3 s | 15.5 s | 183–192 MB | 3 MB |
| image-heavy PPTX / PPT (6 × 1200² noise PNG) | 25–26 MB | 3.7 s | 4.0 s | ~200 MB | 7 MB |
| 50k-row XLSX / XLS | 3 MB / 7 MB | 2.5–3.7 s | 2.3–4.9 s | ~180 MB | 0.1 MB (JSON) |
| 30-sheet XLSX | 3.5 MB | 4.8 s | 6.9 s | 196 MB | 3 MB (JSON) |
| 65k × 250 XLS | 96 MB | 14.7 s | 15 s | 394 MB | 3 MB (JSON) |
| 65k × 250 XLSX | 50 MB | 32.7 s | 50 s | 354 MB | 3 MB (JSON) |
| image-heavy PPTX | 203 MB | — | — | — | refused (413) before LibreOffice |

Concurrency (2 CPUs), 200-page DOCX: 1 job 15.4 s / 182 MB; 2 jobs 17.4 s / 334 MB;
4 jobs 37.4 s / 639 MB. A 96 MiB memory cap: the job fails with `unconvertible` and
the converter keeps serving.

Derived settings: memory **1280M** (two worst-case jobs plus the tmpfs they live in),
concurrency **2**, per-job timeout **90 s** (≈2.7× the slowest measured), output cap
100 MB, input ceiling **100 MiB** (the existing upload cap). Not measured: a ~100 MiB
OOXML with enormous uncompressed content, SmartArt/chart-heavy decks, a host with
fewer than 2 CPUs. Re-run `tests/measure.py` before changing any of this.

## Known limits of the preview (all by design, all shown to the user)

- **Spreadsheets are a data view, not Excel:** values and structure only — no
  formatting, merged cells, charts, images or conditional formatting. A formula
  shows its last-calculated value. **Hidden sheets are exported too** (LibreOffice's
  CSV export does not distinguish them), so they appear as ordinary tabs.
- Word/PowerPoint: animations, embedded video, speaker notes and fonts without a
  metric-compatible substitute differ from Word/PowerPoint.
- A password-protected or corrupt file fails (`422`) → the UI offers Download.
- **The macro positive control cannot fire** in this LibreOffice build: no document
  macro runs even under a deliberately permissive profile, so "the canary never ran"
  is necessary but not sufficient evidence. The sufficient evidence is that no script
  engine is installed (`test_no_script_engines_installed`) plus the profile settings.

## Testing

```
# Build (repo root is the context, like every service image)
docker build -f services/doc-converter/Dockerfile -t doc-converter:dev .

# Fixtures, generated by LibreOffice itself (a few KB each)
docker run --rm --tmpfs /tmp -v "$PWD/services/doc-converter/tests:/tests:ro" -v "$FX:/fx" \
  doc-converter:dev python /tests/make_fixtures.py /fx

# 1. In the image: macro / link canaries (with positive controls), hygiene after every outcome
docker run --rm --tmpfs /tmp:size=512m -v "$PWD/services/doc-converter/tests:/app/tests:ro" -v "$FX:/fx:ro" \
  doc-converter:dev python -W ignore -m unittest tests.test_inimage -v

# 2. HTTP against production-flag containers: hostile input, caps, timeout, concurrency
#    (CONVERTER_URL / CONVERTER_TINY_OUTPUT_URL / CONVERTER_SHORT_TIMEOUT_URL / CONVERTER_ONE_SLOT_URL — see test_server.py)
python3 -m unittest tests.test_server -v          # from services/doc-converter

# 3. Container isolation: uid, read-only fs, no caps, no route out, limits, OOM
tests/security_check.sh

# 4. The shared extension list equals the app's and the server's
python3 -m unittest tests.test_spec

# 5. Everything for real: real messaging-svc binary + Postgres + this container, optionally a real browser
FIXTURE_DIR=$FX LARGE_FIXTURE_DIR=$LARGE tests/e2e/run.sh          # BROWSER=1 adds Chromium
python3 tests/measure.py CONTAINER URL DIR [--concurrency]         # the measurement run
```

CI runs 1–4 (`test-doc-converter` in `.github/workflows/ci.yml`).
