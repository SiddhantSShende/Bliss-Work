import { useEffect, useState } from "react";
import { previewUrl, type DocumentMode } from "../../lib/attachmentCapability";
import { decodeText } from "./decodeText";
import { parseCsv } from "./parseCsv";
import { parseSheetsArtifact, SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetsPreview } from "./sheetsArtifact";

/**
 * How much of a CSV / text file is read. PROVISIONAL: a safety ceiling, not a
 * product decision to hide Open for bigger files — a bigger file simply shows its
 * first part with a notice. To be set from measured parse/render time and memory
 * on the lowest-spec client (plan §3.3).
 */
export const TEXT_PREVIEW_MAX_BYTES = 4 * 1024 * 1024;

/**
 * How long to keep asking about a conversion that is still running. PROVISIONAL:
 * just above the server's own run timeout, so the client gives up only after the
 * server has.
 */
export const PREVIEW_POLL_BUDGET_MS = 3 * 60 * 1000;

const DEFAULT_RETRY_MS = 3000;

export type PreviewFailure =
  /** The document could not be converted or read: corrupt, protected, unsupported, link expired. */
  | "failed"
  | "unavailable"
  | "busy"
  | "tooLarge"
  | "timedOut"
  | "network";

export type DocumentPreview =
  | { status: "loading"; converting: boolean }
  | { status: "error"; reason: PreviewFailure }
  | { status: "ready"; kind: "pdf"; pdfUrl: string }
  /** `fromCsv`: the file is a CSV read in the browser (so the total row count is unknown). */
  | { status: "ready"; kind: "grid"; preview: SheetsPreview; fromCsv: boolean }
  | { status: "ready"; kind: "text"; text: string; truncated: boolean };

const LOADING: DocumentPreview = { status: "loading", converting: false };

/**
 * Loads what the document viewer shows.
 *
 *   pdf / sheet → GET {signed url}/preview. The server authorizes it and has the
 *                 Office Document Sandbox convert the file; while that runs it
 *                 answers 202 and this asks again, until it is ready or the budget
 *                 is spent.
 *   csv / text  → the signed URL itself, read from the start up to a ceiling.
 *
 * `source` is the signed attachment URL (undefined while links are still being
 * minted, which just keeps the state at "loading").
 */
export function useDocumentPreview(source: string | undefined, mode: DocumentMode): DocumentPreview {
  const [state, setState] = useState<DocumentPreview>(LOADING);

  useEffect(() => {
    setState(LOADING);
    if (!source) return;

    const ctl = new AbortController();
    let objectUrl: string | undefined;
    const set = (next: DocumentPreview) => {
      if (!ctl.signal.aborted) setState(next);
    };
    const fail = (reason: PreviewFailure) => set({ status: "error", reason });

    const run = async () => {
      try {
        if (mode === "pdf" || mode === "sheet") await loadConverted(source, mode, ctl.signal, set, fail, (u) => (objectUrl = u));
        else await loadText(source, mode, ctl.signal, set, fail);
      } catch (e) {
        if (!ctl.signal.aborted) fail(e instanceof TypeError ? "network" : "failed");
      }
    };
    void run();

    return () => {
      ctl.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [source, mode]);

  return state;
}

type Setter = (next: DocumentPreview) => void;
type Failer = (reason: PreviewFailure) => void;

async function loadConverted(
  source: string,
  mode: "pdf" | "sheet",
  signal: AbortSignal,
  set: Setter,
  fail: Failer,
  holdUrl: (u: string) => void,
): Promise<void> {
  const url = previewUrl(source);
  const deadline = Date.now() + PREVIEW_POLL_BUDGET_MS;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, { signal });
    } catch {
      if (!signal.aborted) fail("network");
      return;
    }
    if (res.status === 200) return readConverted(res, mode, set, fail, holdUrl);
    if (res.status === 202) {
      if (Date.now() >= deadline) return fail("timedOut");
      set({ status: "loading", converting: true });
      if (!(await sleep(retryAfterMs(res), signal))) return;
      continue;
    }
    return fail(failureFor(res.status));
  }
}

async function readConverted(
  res: Response,
  mode: "pdf" | "sheet",
  set: Setter,
  fail: Failer,
  holdUrl: (u: string) => void,
): Promise<void> {
  if (mode === "pdf") {
    // Re-type the blob: the PDF viewer needs application/pdf, whatever the transport said.
    const blob = new Blob([await res.arrayBuffer()], { type: "application/pdf" });
    const pdfUrl = URL.createObjectURL(blob);
    holdUrl(pdfUrl);
    return set({ status: "ready", kind: "pdf", pdfUrl });
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return fail("failed");
  }
  const preview = parseSheetsArtifact(raw);
  if (!preview) return fail("failed");
  set({ status: "ready", kind: "grid", preview, fromCsv: false });
}

async function loadText(
  source: string,
  mode: "csv" | "text",
  signal: AbortSignal,
  set: Setter,
  fail: Failer,
): Promise<void> {
  const res = await fetch(source, { signal });
  if (!res.ok) return fail(failureFor(res.status));
  const { bytes, truncated } = await readPrefix(res, TEXT_PREVIEW_MAX_BYTES);
  let { text } = decodeText(bytes);
  // A cut file usually ends mid-line; show whole lines only.
  if (truncated) {
    const nl = text.lastIndexOf("\n");
    if (nl > 0) text = text.slice(0, nl);
  }
  if (mode === "text") return set({ status: "ready", kind: "text", text, truncated });

  const csv = parseCsv(text, { maxRows: SHEET_MAX_ROWS, maxCols: SHEET_MAX_COLS });
  const cut = truncated || csv.truncatedRows || csv.truncatedCols;
  set({
    status: "ready",
    kind: "grid",
    fromCsv: true,
    preview: { sheets: [{ name: "", rows: csv.rows, totalRows: csv.rows.length, truncated: cut }], moreSheets: false },
  });
}

/** Reads at most `max` bytes of the body and stops the download there. */
export async function readPrefix(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    return all.length > max ? { bytes: all.subarray(0, max), truncated: true } : { bytes: all, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > max) {
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const out = new Uint8Array(Math.min(total, max));
  let off = 0;
  for (const c of chunks) {
    if (off >= out.length) break;
    const take = Math.min(c.length, out.length - off);
    out.set(c.subarray(0, take), off);
    off += take;
  }
  return { bytes: out, truncated };
}

function failureFor(status: number): PreviewFailure {
  if (status === 413) return "tooLarge";
  if (status === 429) return "busy";
  if (status === 503 || status === 502 || status === 504) return "unavailable";
  return "failed";
}

function retryAfterMs(res: Response): number {
  const secs = Number(res.headers.get("Retry-After"));
  if (!Number.isFinite(secs) || secs <= 0) return DEFAULT_RETRY_MS;
  return Math.min(Math.max(secs, 1), 10) * 1000;
}

/** Resolves true after `ms`, or false if aborted first. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
