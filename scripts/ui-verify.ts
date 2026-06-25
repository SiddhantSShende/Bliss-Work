/**
 * Headless browser verification of the people-centric inbox UI.
 *   npx tsx scripts/ui-verify.ts   (web dev server on :5173 + stack up)
 *
 * Seeds a fresh message + SENT task alice→bob, then drives Chromium as bob:
 * login → inbox (people pane + feed) → per-person filter → Compose dialog
 * (message + task modes). Captures screenshots into .ui-verify/ and prints the
 * rendered pane text so the layout can be asserted.
 */
import { chromium } from "playwright";

const AUTH = "http://localhost:8001";
const TASK = "http://localhost:8002";
const MSG = "http://localhost:8004";
const PW = "Passw0rd!";
const uuid = () => crypto.randomUUID();

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
  // ── seed fresh, visible items for bob ────────────────────────────────────
  const alice = await login("alice@acme.com");
  const bob = await login("bob@acme.com");
  await fetch(`${MSG}/api/v1/conversations/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${alice.accessToken}` },
    body: JSON.stringify({ recipientId: bob.user.id, body: "Can you review the Q3 deck today?", clientMsgId: uuid() }),
  });
  await fetch(`${TASK}/api/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${alice.accessToken}`, "idempotency-key": uuid() },
    body: JSON.stringify({ title: "Review Q3 deck", description: "Leave comments by EOD.", assigneeIds: [bob.user.id] }),
  });
  console.log("seeded message + SENT task alice→bob");

  const browser = await chromium.launch();
  const page = await browser.newContext({ viewport: { width: 1280, height: 800 } }).then((c) => c.newPage());
  page.on("console", (m) => m.type() === "error" && console.log("PAGE-ERR:", m.text()));
  page.on("pageerror", (e) => console.log("PAGE-CRASH:", e.message));

  // ── login as bob ─────────────────────────────────────────────────────────
  await page.goto("http://localhost:5173/login");
  await page.fill("input[type=email]", "bob@acme.com");
  await page.fill("input[type=password]", PW);
  await page.click('button[type=submit]');
  await page.waitForURL("**/app/**", { timeout: 20000 });
  await page.waitForSelector("text=Alice Admin", { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: ".ui-verify/01-inbox-all.png" });

  const people = await page.locator("aside").innerText().catch(() => "");
  const feed = await page.locator("main").innerText().catch(() => "");
  console.log("\n── PEOPLE PANE ──\n" + people);
  console.log("\n── FEED PANE ──\n" + feed);

  // ── filter to one person ─────────────────────────────────────────────────
  await page.click("text=Alice Admin");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: ".ui-verify/02-filter-alice.png" });
  console.log("\n── FEED (alice filter) ──\n" + (await page.locator("main").innerText().catch(() => "")));

  // ── Compose: message mode, then task mode ────────────────────────────────
  await page.click('[title="Compose — message or task"]');
  await page.waitForSelector("form >> text=Message", { timeout: 5000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: ".ui-verify/03-compose-message.png" });

  await page.getByRole("button", { name: "Task", exact: true }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: ".ui-verify/04-compose-task.png" });

  await browser.close();
  console.log("\nDONE — screenshots in .ui-verify/");
}

main().catch((e) => {
  console.error("ui-verify crashed:", e);
  process.exit(1);
});
