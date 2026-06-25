/**
 * Verifies the desktop sticky flow end-to-end (drives the real built app via
 * Playwright's _electron API):
 *   npx tsx scripts/desktop-verify.ts   (stack up; apps/desktop built)
 *
 * A task floats on the desktop the moment it's ALLOCATED (no manual pin / prior
 * acknowledge). This:
 *   1. Seeds a fresh SENT task alice→bob.
 *   2. Launches the desktop app (throwaway user-data-dir to dodge a running
 *      instance's single-instance lock) and logs in as bob.
 *   3. Asserts the task AUTO-POPS as a floating sticky WITHOUT acknowledging it,
 *      showing two icon buttons: ✓ Acknowledge and ✗ Ignore.
 *   4. Clicks Acknowledge on the sticky → asserts it transitions to the locked
 *      Complete note (the post-acknowledge commitment marker).
 * Screenshots land in .ui-verify/.
 */
import path from "node:path";
import os from "node:os";
import { _electron as electron, type Page } from "playwright";

const AUTH = "http://localhost:8001";
const TASK = "http://localhost:8002";
const PW = "Passw0rd!";
const uuid = () => crypto.randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function login(email: string) {
  const r = await fetch(`${AUTH}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PW }),
  });
  if (!r.ok) throw new Error(`login ${email} → ${r.status}`);
  return (await r.json()) as { accessToken: string; user: { id: string } };
}

async function main() {
  const alice = await login("alice@acme.com");
  const bob = await login("bob@acme.com");
  const title = `Desktop sticky check ${Date.now().toString().slice(-5)}`;
  await fetch(`${TASK}/api/v1/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${alice.accessToken}`,
      "idempotency-key": uuid(),
    },
    body: JSON.stringify({
      title,
      description: "Should pop up on the desktop with two icon buttons before acknowledge.",
      assigneeIds: [bob.user.id],
    }),
  });
  console.log("seeded SENT task:", title);

  const desktopDir = path.resolve("apps/desktop");
  const env = { ...process.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE; // VS Code shell sets this; it breaks Electron.
  const udd = path.join(os.tmpdir(), "bw-verify-" + Date.now().toString().slice(-6));

  const app = await electron.launch({
    args: ["out/main/index.js", `--user-data-dir=${udd}`],
    cwd: desktopDir,
    env,
  });

  // Match the sticky for THIS run's task by title — other actionable tasks
  // (e.g. leftovers from a previous run) legitimately float at the same time.
  const findSticky = async (): Promise<Page | null> => {
    for (let i = 0; i < 60; i++) {
      for (const w of app.windows()) {
        if (!w.url().includes("sticky")) continue;
        const t = await w.innerText("body").catch(() => "");
        if (t.includes(title)) return w;
      }
      await sleep(500);
    }
    return null;
  };

  try {
    const win = await app.firstWindow();
    win.on("console", (m) => m.type() === "error" && console.log("REND-ERR:", m.text()));
    await win.waitForLoadState("domcontentloaded");
    await win.waitForSelector("input[type=email]", { timeout: 20000 });
    await win.fill("input[type=email]", "bob@acme.com");
    await win.fill("input[type=password]", PW);
    await win.click("button[type=submit]");
    await win.waitForSelector("text=Inbox", { timeout: 20000 });
    console.log("logged in as bob; waiting for the SENT task to auto-pop (no acknowledge)…");

    const sticky = await findSticky();
    if (!sticky) {
      console.log("❌ FAIL  no sticky window auto-popped for the SENT task");
      process.exitCode = 1;
      return;
    }
    await sticky.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(1500);
    const popText = await sticky.innerText("body").catch(() => "");
    const hasAck = await sticky.locator('[title="Acknowledge"]').count();
    const hasIgnore = await sticky.locator('[title="Ignore"]').count();
    console.log("AUTO-POP content:\n" + popText.slice(0, 200));
    console.log(`buttons → Acknowledge:${hasAck} Ignore:${hasIgnore}`);
    await sticky.screenshot({ path: ".ui-verify/desktop-01-autopop.png" }).catch(() => {});

    // The occlusion fix: the sticky must be ALWAYS-ON-TOP so it surfaces over the
    // focused main window instead of hiding behind it. Checked in the main process.
    const onTop: boolean | null = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((win) =>
        win.webContents.getURL().includes("sticky"),
      );
      return w ? w.isAlwaysOnTop() : null;
    });
    console.log("sticky isAlwaysOnTop:", onTop);

    const popped = popText.includes(title);
    const twoButtons = hasAck > 0 && hasIgnore > 0;
    const alwaysOnTop = onTop === true;

    // Acknowledge from the sticky → should lock to a Complete-only note.
    await sticky.locator('[title="Acknowledge"]').first().click();
    await sleep(3000);
    const ackText = await sticky.innerText("body").catch(() => "");
    const hasComplete = await sticky.locator('[title="Complete"]').count();
    const ackGone = (await sticky.locator('[title="Acknowledge"]').count()) === 0;
    console.log("AFTER-ACK content:\n" + ackText.slice(0, 200));
    console.log(`Complete button:${hasComplete}  Acknowledge gone:${ackGone}`);
    await sticky.screenshot({ path: ".ui-verify/desktop-02-after-ack.png" }).catch(() => {});

    const transitioned = hasComplete > 0 && ackGone;
    const ok = popped && twoButtons && alwaysOnTop && transitioned;
    console.log(
      `\n${ok ? "✅ PASS" : "❌ FAIL"}  autopop(${popped}) twoIconButtons(${twoButtons}) alwaysOnTop(${alwaysOnTop}) ackTransition(${transitioned})`,
    );
    process.exitCode = ok ? 0 : 1;
  } finally {
    await app.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error("desktop-verify crashed:", e);
  process.exit(1);
});
