import path from "node:path";
import os from "node:os";
import { _electron as electron } from "playwright";

const PW = "Passw0rd!";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const desktopDir = path.resolve("apps/desktop");
  const env = { ...process.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE; // VS Code sets this; it breaks Electron.

  // Isolated user-data-dir so this instance does NOT collide with the user's
  // running packaged app (single-instance lock is keyed on userData).
  const udd = path.join(os.tmpdir(), "bw-shot-" + Date.now().toString().slice(-6));

  const app = await electron.launch({
    args: ["out/main/index.js", `--user-data-dir=${udd}`],
    cwd: desktopDir,
    env,
  });
  try {
    const win = await app.firstWindow();
    win.on("console", (m) => m.type() === "error" && console.log("REND-ERR:", m.text()));
    win.on("pageerror", (e) => console.log("REND-CRASH:", e.message));
    await win.waitForLoadState("domcontentloaded");
    await win.waitForSelector("input[type=email]", { timeout: 20000 });
    await sleep(800);
    await win.screenshot({ path: ".shot/desktop-01-login.png" });

    await win.fill("input[type=email]", "alice@acme.com");
    await win.fill("input[type=password]", PW);
    await win.click("button[type=submit]");
    await win.waitForSelector("text=Inbox", { timeout: 20000 });
    await sleep(2500);
    await win.screenshot({ path: ".shot/desktop-02-inbox.png" });
    console.log("url:", win.url());
    const body = await win.locator("body").innerText().catch(() => "");
    console.log("\n── DESKTOP BODY TEXT (first 1000) ──\n" + body.slice(0, 1000));

    // Visit Tasks + Channels to capture more screens.
    for (const [label, sel, file] of [
      ["Tasks", "text=Tasks", ".shot/desktop-03-tasks.png"],
      ["Channels", "text=Channels", ".shot/desktop-04-channels.png"],
    ] as const) {
      try {
        await win.locator(sel).first().click();
        await sleep(1500);
        await win.screenshot({ path: file });
        console.log(`captured ${label}`);
      } catch (e) {
        console.log(`skip ${label}:`, String(e).slice(0, 120));
      }
    }
  } finally {
    await app.close().catch(() => {});
  }
  console.log("DONE — desktop screenshots in .shot/");
}
main().catch((e) => { console.error("dshot crashed:", e); process.exit(1); });
