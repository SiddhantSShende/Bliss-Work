/**
 * Desktop task-note gate — are "Acknowledge" and "Ignore" actually on screen?
 *
 *   npm run build -w @taskboard/desktop && npx tsx scripts/sticky-labels-check.ts
 *
 * The floating task note is an Electron window that is FIXED SIZE, USER
 * RESIZABLE, and whose document is `overflow: hidden` (renderer/sticky.html).
 * Those three together make a layout bug invisible in every other test we have:
 * content taller than the window is not scrolled to, it is silently cut off —
 * and the action row is the last thing in the card, so it is the first thing to
 * go. The buttons stayed in the DOM the whole time, which is why unit tests
 * found nothing; they were simply below the bottom edge of the window.
 *
 * jsdom cannot catch this — it does no layout — so this drives the REAL built
 * renderer in Chromium at the real window sizes the note can be resized to,
 * and asserts each label is fully inside the viewport and not clipped inside
 * its own button.
 *
 * Sizes below must track windows.ts / sticky-manager.ts: 360x200 default,
 * 300x140 minimum.
 */
import { chromium, type Page } from "playwright";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve("apps/desktop/out/renderer");

/** Every size the note can legitimately be, including the extremes. */
const SIZES = [
  { w: 360, h: 200, label: "default note" },
  { w: 300, h: 140, label: "minimum size (fully shrunk)" },
  { w: 360, h: 140, label: "wide but shrunk to minimum height" },
  { w: 300, h: 200, label: "narrowest, default height" },
  { w: 520, h: 320, label: "user-enlarged" },
];

/** A SENT task — the state that offers Acknowledge and Ignore. */
const SENT = {
  taskId: "t1",
  title: "Prepare the Q3 compliance summary",
  description:
    "Pull the audit export for July and August, reconcile it against the member " +
    "activity report, and flag anything that looks off before Friday.",
  senderUsername: "j.okafor",
  senderDisplayName: "Jomo Okafor",
  myStatus: "SENT",
  actions: ["ACKNOWLEDGE", "IGNORE"],
};

/** No description — the card is shorter, and nothing may reflow oddly. */
const SENT_BARE = { ...SENT, description: "", title: "Sign the vendor addendum" };

/** After acknowledging, the note locks to Complete only. Same clipping risk. */
const ACKED = {
  ...SENT,
  myStatus: "ACKNOWLEDGED",
  actions: ["COMPLETE"],
};

const CASES = [
  { task: SENT, expect: ["Acknowledge", "Ignore"], label: "SENT" },
  { task: SENT_BARE, expect: ["Acknowledge", "Ignore"], label: "SENT, no description" },
  { task: ACKED, expect: ["Complete"], label: "ACKNOWLEDGED" },
];

/**
 * Stand-in for the `sticky` preload bridge (apps/desktop/src/preload/sticky.ts).
 *
 * Injected as a source string rather than a function: tsx transpiles this file
 * with esbuild, and a serialized arrow function drags esbuild's `__name` helper
 * into a page that has no such symbol — the note then fails to mount and every
 * assertion below reports "no button rendered", which looks like the very bug
 * this script exists to detect.
 */
function stickyPreloadStub(task: unknown): string {
  return `
    (() => {
      const task = ${JSON.stringify(task)};
      let cb = null;
      window.sticky = {
        taskId: task.taskId,
        collapsed: false,
        onTask: (fn) => { cb = fn; return () => {}; },
        act: () => {},
        setCollapsed: () => {},
        ready: () => { if (cb) cb(task); },
        dismiss: () => {},
      };
    })();
  `;
}

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

/** Serve the built renderer over http — file:// blocks ES module imports. */
async function serve(): Promise<{ url: string; close: () => void }> {
  const TYPES: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
  };
  const server = http.createServer(async (req, res) => {
    const file = path.join(ROOT, decodeURIComponent((req.url ?? "/").split("?")[0]!));
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
  return { url: `http://127.0.0.1:${port}/sticky.html`, close: () => server.close() };
}

type Measured = {
  text: string;
  insideViewport: boolean;
  clippedInsideButton: boolean;
  top: number;
  bottom: number;
  right: number;
};

/** Where each action button actually landed, and whether its label survived. */
async function measure(page: Page): Promise<Measured[]> {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // The action row only — the header's icon buttons carry no label.
    return Array.from(document.querySelectorAll("button"))
      .filter((b) => /Acknowledge|Ignore|Complete/.test(b.textContent ?? ""))
      .map((b) => {
        const r = b.getBoundingClientRect();
        return {
          text: (b.textContent ?? "").trim(),
          insideViewport: r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw,
          // A button wide enough to sit on screen can still have its own text
          // overflowing, which reads as a truncated or missing label.
          clippedInsideButton: b.scrollWidth > b.clientWidth + 1,
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          right: Math.round(r.right),
        };
      });
  });
}

async function main() {
  const { url, close } = await serve();
  const browser = await chromium.launch();
  try {
    for (const { task, expect, label: caseLabel } of CASES) {
      console.log(`\n${caseLabel}`);
      for (const { w, h, label } of SIZES) {
        const page = await browser.newPage({ viewport: { width: w, height: h } });
        await page.addInitScript({ content: stickyPreloadStub(task) });
        await page.goto(url);
        await page.waitForSelector(`text=${expect[0]}`, { timeout: 4_000 }).catch(() => {});

        const found = await measure(page);
        const where = `${w}x${h} (${label})`;

        for (const wanted of expect) {
          const btn = found.find((b) => b.text === wanted);
          if (!btn) {
            fail(`${where}: no "${wanted}" button rendered at all`);
            continue;
          }
          if (!btn.insideViewport) {
            fail(
              `${where}: "${wanted}" is outside the window ` +
                `(top=${btn.top} bottom=${btn.bottom} right=${btn.right}, window is ${w}x${h}) — ` +
                "the document cannot scroll, so it is invisible",
            );
            continue;
          }
          if (btn.clippedInsideButton) {
            fail(`${where}: "${wanted}" label is clipped inside its own button`);
            continue;
          }
          pass(`${where}: "${wanted}" fully visible`);
        }
      }
    }
  } finally {
    await browser.close();
    close();
  }

  console.log(`\n${checksRun} passed, ${failures} failed.`);
  if (failures > 0) process.exit(1);
  if (checksRun === 0) {
    console.error(
      "\nNo checks ran. Build the desktop renderer first:\n" +
        "  npm run build -w @taskboard/desktop",
    );
    process.exit(1);
  }
  console.log("Every task-note action label is on screen at every allowed window size.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
