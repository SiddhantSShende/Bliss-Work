/**
 * Browser verification for the WhatsApp forward flow, against the running dev
 * stack + `npm run web`.
 *   npx tsx scripts/forward-link-ui.ts
 *
 * The flow is one click: the message menu's "Forward to WhatsApp" is a real
 * anchor to https://wa.me/?text=… , so the browser navigates on its own and
 * WhatsApp asks who to send to. There is no in-app dialog, no contact picker
 * and no number to type — the recipient is chosen inside WhatsApp, which is why
 * this runs identically on a desktop browser that has no navigator.contacts.
 *
 * What the click does NOT do is record anything. The audit pill is written only
 * once the user has been away and come back (lib/useWhatsAppForward.ts), so a
 * blocked popup or a bounce off the WhatsApp login wall leaves the thread
 * clean. Sections 3–5 below are about exactly that.
 *
 * The wa.me navigation is aborted at the network layer: the point is to exercise
 * our side of the handoff, not to open a stranger's WhatsApp from a test run.
 */
import { chromium, type Page } from "playwright";
import { BASE, api, login } from "./_tb";

const WEB = process.env.TB_WEB ?? "http://localhost:5173";
const PASSWORD = "Passw0rd!9";
const PILL = "Opened WhatsApp to forward this message";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function openMenuFor(page: Page, text: string) {
  const row = page.locator("div.group").filter({ hasText: text }).last();
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await page.waitForTimeout(300);
  await row.getByLabel("Message actions").click();
  await page.waitForTimeout(400);
}

/**
 * Leave for `awayMs` and come back.
 *
 * The events are dispatched rather than produced by really backgrounding the
 * tab, because headless Chromium keeps every page's renderer active: opening a
 * second page or calling bringToFront() fires neither visibilitychange nor
 * blur/focus (verified). Everything downstream of the signal — the dwell
 * measurement, the POST, the pill, the toast — is the real thing.
 *
 * Date.now is stubbed for the duration so a 30-second trip does not cost the
 * run 30 seconds; the hook reads it synchronously inside the handlers.
 */
async function simulateTrip(page: Page, awayMs: number) {
  await page.evaluate((ms) => {
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow.call(Date) + offset;
    try {
      window.dispatchEvent(new Event("blur"));
      offset = ms;
      window.dispatchEvent(new Event("focus"));
    } finally {
      Date.now = realNow;
    }
  }, awayMs);
}

/**
 * How many times the pill text is on screen.
 *
 * One forward yields TWO matches, not one: the pill in the thread plus the
 * conversation-list row, whose preview is clamped by CSS and so still carries
 * the full string in the DOM. Callers therefore compare against a baseline
 * rather than assuming a count.
 */
async function pillCount(page: Page) {
  return page.getByText(PILL).count();
}

/** Poll until the pill count moves past `baseline`, or give up. */
async function waitForNewPill(page: Page, baseline: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await pillCount(page)) > baseline) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function sendTo(token: string, recipientId: string, body: string) {
  return api<{ conversationId: string }>(BASE.msg, "/api/v1/conversations/messages", {
    token,
    body: { recipientId, body, clientMsgId: crypto.randomUUID() },
  });
}

async function main() {
  console.log("── WhatsApp forward UI ──\n");

  // Messages of our own, so assertions do not depend on what earlier runs left.
  const alice = await login("alice@acme.com");
  const bob = await login("bob@acme.com");
  const tag = crypto.randomUUID().slice(0, 8);
  const bodyTrip = `Invoice ${tag} is approved`;
  const bodyBounce = `Invoice ${tag} needs review`;
  const sent = await sendTo(alice.accessToken, bob.user.id, bodyTrip);
  await sendTo(alice.accessToken, bob.user.id, bodyBounce);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 780 } });
  await ctx.route("**://wa.me/**", (r) => r.abort());
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("PAGE-CRASH:", e.message));

  await page.goto(`${WEB}/login`, { waitUntil: "networkidle" });
  await page.fill("input[type=email]", "bob@acme.com");
  await page.fill("input[type=password]", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL("**/app/**", { timeout: 30000 });
  await page.goto(`${WEB}/app/chats/${sent.conversationId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(2200);

  console.log("1 — the action, on a browser with no Contact Picker:");
  check(
    "navigator.contacts genuinely absent here",
    !(await page.evaluate(() => "contacts" in navigator && "ContactsManager" in window)),
    "and the flow works anyway",
  );
  await openMenuFor(page, bodyTrip);
  const link = page.getByRole("menuitem", { name: /forward to whatsapp/i });
  check("menu offers 'Forward to WhatsApp'", await link.isVisible());
  check(
    "it is an anchor, so the browser navigates and no popup blocker fires",
    (await link.evaluate((el) => el.tagName)) === "A",
  );
  check("a WhatsApp glyph is shown, not a generic arrow", await link.locator("svg").isVisible());
  check(
    "no 'Forward to a contact…' entry — numbers are never typed here",
    (await page.getByRole("menuitem", { name: /forward to a contact/i }).count()) === 0,
  );
  await page.screenshot({ path: ".shot/ui-01-menu.png" });

  console.log("\n2 — the link it points at:");
  const href = await link.getAttribute("href");
  check(
    `href carries NO recipient, so WhatsApp asks (got ${href?.slice(0, 34)}…)`,
    !!href && href.startsWith("https://wa.me/?text="),
  );
  check(
    "the message body is URL-encoded into it",
    decodeURIComponent((href ?? "").split("?text=")[1] ?? "") === bodyTrip,
  );
  check("opens in a new tab", (await link.getAttribute("target")) === "_blank");
  check(
    "does not hand window.opener to wa.me",
    ((await link.getAttribute("rel")) ?? "").includes("noopener"),
  );

  console.log("\n3 — clicking it records NOTHING yet:");
  const before = await pillCount(page);
  const popup = ctx.waitForEvent("page").catch(() => null);
  await link.click();
  const opened = await popup;
  if (opened) await opened.close().catch(() => {});
  check("a new tab was targeted at WhatsApp", !!opened);
  await page.waitForTimeout(2500);
  check(
    `no pill was written on the click alone (${before} → ${await pillCount(page)})`,
    (await pillCount(page)) === before,
  );
  check(
    "and no success toast, because nothing has been forwarded yet",
    (await page.getByText(/forwarded through whatsapp/i).count()) === 0,
  );
  await page.screenshot({ path: ".shot/ui-02-armed-no-pill.png" });

  console.log("\n4 — coming back from WhatsApp records it:");
  await simulateTrip(page, 30_000);
  const landed = await waitForNewPill(page, before);
  check(`the pill now appears (${before} → ${await pillCount(page)})`, landed);
  const pillText = await page.getByText(PILL).last().innerText();
  check(
    `pill names no recipient, because none is knowable (got "${pillText.split("\n")[0]}")`,
    !/\+\d/.test(pillText),
  );
  check(
    "a success toast confirms the handoff",
    await page.getByText(/forwarded through whatsapp/i).first().isVisible(),
  );
  await page.screenshot({ path: ".shot/ui-03-returned-pill.png" });

  console.log("\n5 — bouncing straight back records nothing:");
  // The WhatsApp login wall: the user leaves and turns round immediately.
  const beforeBounce = await pillCount(page);
  await openMenuFor(page, bodyBounce);
  const link2 = page.getByRole("menuitem", { name: /forward to whatsapp/i });
  const popup2 = ctx.waitForEvent("page").catch(() => null);
  await link2.click();
  const opened2 = await popup2;
  if (opened2) await opened2.close().catch(() => {});
  await simulateTrip(page, 800);
  await page.waitForTimeout(2500);
  check(
    `no pill for a trip that never happened (${beforeBounce} → ${await pillCount(page)})`,
    (await pillCount(page)) === beforeBounce,
  );
  await page.screenshot({ path: ".shot/ui-04-bounce-no-pill.png" });

  await browser.close();
  console.log(`\n${failures === 0 ? "✅ all UI checks passed" : `❌ ${failures} check(s) failed`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n💥 ui verification crashed:", e);
  process.exit(1);
});
