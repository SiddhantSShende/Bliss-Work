/**
 * Chat drag-and-drop gate — a dropped image must ATTACH, never send.
 *
 *   npx vite build --config scripts/fixtures/chat-drop/vite.config.ts
 *   npx tsx scripts/chat-drop-check.ts
 *
 * Web and desktop run the same bundle, so one browser run covers both: every
 * chat surface (DMView, ChannelView, InboxThread) gets its drop behaviour from
 * the one `useChatMedia` hook this fixture mounts.
 *
 * WHY A BROWSER. This behaviour already had a unit test, and the bug was
 * reported again anyway. jsdom implements no drag-and-drop at all: `fireEvent.
 * drop` fabricates an event object and hands it straight to React, which means
 * it cannot see the two things that decide what a real user gets —
 *
 *   1. whether `dragover` was cancelled, which is the ONLY thing that makes an
 *      element accept a drop. Miss it and Chromium never fires `drop`; the
 *      unit test still passes because it dispatched `drop` itself.
 *   2. a real `DataTransfer`, whose `files` list is emptied the moment the
 *      handler returns. Anything that reads it asynchronously finds nothing —
 *      the same live-list trap that silently swallowed the file picker.
 *
 * So this drives real DragEvents carrying a real File, and asserts on what the
 * user would see: a confirmation prompt, then a preview chip in the tray, and
 * nothing sent until Send is pressed.
 */
import { chromium, type Page } from "playwright";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const DIST = path.resolve("scripts/fixtures/chat-drop/dist");
const ATTACHMENT_ID = "018f0000-0000-7000-8000-0000000000aa";

let failures = 0;
let checksRun = 0;

function fail(msg: string) {
  failures++;
  console.error(`  ✗ ${msg}`);
}

function pass(msg: string) {
  checksRun++;
  console.log(`  ✓ ${msg}`);
}

/**
 * Serves the fixture AND stands in for messaging-svc's attachment endpoint,
 * so the real ApiClient does a real multipart XHR upload.
 */
async function serve(): Promise<{ url: string; uploads: string[]; close: () => void }> {
  const uploads: string[] = [];
  const TYPES: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (/^\/api\/v1\/attachments\/[^/]+\/commit$/.test(url.pathname)) {
      req.resume();
      req.on("end", () => res.writeHead(204).end());
      return;
    }
    if (url.pathname === "/api/v1/attachments") {
      const filename = "photo.png";
      uploads.push(url.searchParams.get("scopeId") ?? "?");
      // Drain the body so the XHR completes.
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: ATTACHMENT_ID,
            scope: "thread",
            scopeId: url.searchParams.get("scopeId"),
            role: url.searchParams.get("role") ?? "file",
            sha256: "0".repeat(64),
            mime: "image/png",
            sizeBytes: 3,
            filename,
            createdAt: new Date(0).toISOString(),
          }),
        );
      });
      return;
    }
    const file = path.join(DIST, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/`, uploads, close: () => server.close() };
}

/**
 * A REAL drag-and-drop: build a DataTransfer holding a File and dispatch the
 * genuine event sequence at the drop target. `dragover` is dispatched
 * cancelable, so if the app fails to call preventDefault the browser refuses
 * the drop exactly as it would for a user — and this reports it.
 */
async function dropImage(page: Page, selector: string): Promise<{ dragoverAccepted: boolean }> {
  // Evaluated as SOURCE, not as a function: tsx transpiles this file with
  // esbuild, which rewrites named inner functions to reference its `__name`
  // helper — a symbol the page has never heard of.
  return page.evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) throw new Error("no drop target: " + ${JSON.stringify(selector)});
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" }));
    const fire = (type) => {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    fire("dragenter");
    const dragoverAccepted = fire("dragover");
    fire("drop");
    return { dragoverAccepted };
  })()`) as Promise<{ dragoverAccepted: boolean }>;
}

/**
 * The places a user actually lets go of an image. All three are inside the
 * dropzone, but they are different elements with different browser defaults —
 * a textarea in particular has its own drop handling — so each is dispatched
 * at, rather than assumed equivalent to, the container.
 */
const TARGETS = [
  { selector: '[data-testid="dropzone"]', label: "the chat area" },
  { selector: "textarea", label: "the message box itself" },
  { selector: '[title="Send"]', label: "the Send button" },
];

async function checkTarget(page: Page, url: string, uploads: string[], target: {
  selector: string;
  label: string;
}) {
  console.log(`\ndropping an image on ${target.label}`);
  uploads.length = 0;
  await page.goto(url);
  await page.waitForSelector('[data-testid="dropzone"]', { timeout: 10_000 });

  const { dragoverAccepted } = await dropImage(page, target.selector);
  if (dragoverAccepted) {
    pass("dragover is cancelled — the chat accepts the drop");
  } else {
    fail(
      "dragover was NOT cancelled, so a real browser refuses the drop entirely: " +
        "the image never reaches the chat",
    );
  }

  // A drop ASKS FIRST. It is the one gesture a user can perform entirely by
  // accident, so nothing at all happens — not even an upload — until they say
  // yes.
  await page.waitForSelector("text=Attach this file?", { timeout: 10_000 }).catch(() => {});
  const asked = await page.evaluate(
    `document.body.textContent.includes("Attach this file?")`,
  );
  if (asked) pass("the drop asks for confirmation before anything happens");
  else fail("the drop did not ask — it acted on its own");

  if (uploads.length === 0) pass("nothing is uploaded until the drop is confirmed");
  else fail(`the drop uploaded ${uploads.length} file(s) before the user confirmed`);

  await page.getByRole("button", { name: "Attach", exact: true }).click();

  // Once confirmed the upload begins immediately (that is what keeps the
  // progress bar honest and Send instant) — but it must end in the tray, not on
  // the wire.
  //
  // The chip is a <span> with the filename plus a "Remove <name>" control —
  // that button is the unambiguous signal that the file is STAGED and still
  // removable, rather than gone.
  await page
    .waitForSelector('[aria-label="Remove photo.png"]', { timeout: 10_000 })
    .catch(() => {});

  const previewed = await page.evaluate(
    `!!document.querySelector('[aria-label="Remove photo.png"]')`,
  );
  if (previewed) pass('the dropped image appears as a preview chip ("photo.png")');
  else fail("the dropped image produced no preview chip — it was not attached");

  if (uploads.length === 1) pass("the file was uploaded once");
  else fail(`expected exactly one upload, saw ${uploads.length}`);

  const sent = await page.evaluate(`window.__sent`) as string[];
  if (sent.length === 0) pass("nothing was sent — the message waits for the user");
  else fail(`the drop SENT ${sent.length} message(s) on its own: ${JSON.stringify(sent)}`);

  if (!previewed) return;

  // And the other half of the contract: Send must then actually send it.
  await page.click('[title="Send"]');
  await page
    .waitForFunction(`window.__sent.length > 0`, null, { timeout: 5_000 })
    .catch(() => {});
  const afterSend = (await page.evaluate(`window.__sent`)) as string[];
  if (afterSend.length === 1 && afterSend[0]!.includes(ATTACHMENT_ID)) {
    pass("clicking Send emits exactly one message carrying the attachment");
  } else {
    fail(`Send produced ${JSON.stringify(afterSend)}`);
  }
}

/**
 * Cancelling costs nothing. Asserted separately from the accept path because
 * the guarantee is different in kind: not "it waits for Send" but "the bytes
 * never left the machine", which is what makes an accidental drop free.
 */
async function checkCancel(page: Page, url: string, uploads: string[]) {
  console.log("\ncancelling a dropped image");
  uploads.length = 0;
  await page.goto(url);
  await page.waitForSelector('[data-testid="dropzone"]', { timeout: 10_000 });

  await dropImage(page, '[data-testid="dropzone"]');
  await page.waitForSelector("text=Attach this file?", { timeout: 10_000 }).catch(() => {});
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.waitForFunction(
    `!document.body.textContent.includes("Attach this file?")`,
    null,
    { timeout: 5_000 },
  ).catch(() => {});

  if (uploads.length === 0) pass("cancelling uploads nothing at all");
  else fail(`cancelling still uploaded ${uploads.length} file(s)`);

  const staged = await page.evaluate(
    `!!document.querySelector('[aria-label="Remove photo.png"]')`,
  );
  if (!staged) pass("cancelling leaves nothing in the tray");
  else fail("the cancelled file was attached anyway");

  const sent = (await page.evaluate(`window.__sent`)) as string[];
  if (sent.length === 0) pass("cancelling sends nothing");
  else fail(`cancelling SENT ${sent.length} message(s)`);
}

async function main() {
  const { url, uploads, close } = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  try {
    page.on("pageerror", (e) => fail(`uncaught page error: ${e.message}`));
    for (const target of TARGETS) await checkTarget(page, url, uploads, target);
    await checkCancel(page, url, uploads);
  } finally {
    await browser.close();
    close();
  }

  console.log(`\n${checksRun} passed, ${failures} failed.`);
  if (failures > 0) process.exit(1);
  if (checksRun === 0) {
    console.error("\nNo checks ran. Build the fixture first:\n  npx vite build --config scripts/fixtures/chat-drop/vite.config.ts");
    process.exit(1);
  }
  console.log("A dropped image asks first, then attaches and waits for Send, wherever it is dropped.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
