/**
 * Browser check for the three call surfaces, driven against a running stack.
 *
 *   npx tsx scripts/calls-ui-check.ts [baseUrl]
 *
 * What it asserts, and why each one is here rather than in a vitest file:
 *
 *   MEETINGS      that the rail entry exists directly under Inbox, that the
 *                 page renders from GET /api/v1/calls, and that what is on
 *                 screen is the data the SERVER returned — a component test
 *                 with a mocked api() proves the opposite of that.
 *   CALL MENU     that a chat header holds exactly ONE call control and that it
 *                 opens exactly FOUR options. "Only one" is a statement about
 *                 the whole header, which only a real render can make.
 *   IN-CALL       that the five controls, the red sharing indicator and the
 *                 sliding panel behave, using the dev-only /call-preview.html
 *                 harness (a real ring needs two browsers and a peer connection).
 *
 * Console errors and failed requests are collected throughout and reported at
 * the end — a page that renders correctly while throwing is not passing.
 */
import { chromium, type Browser, type Page, type Request, type Response } from "playwright";
import { BASE, api, createOrgOrLogin, inviteAndAccept, PASSWORD, type Session } from "./_tb";

const WEB = (process.argv[2] ?? "http://localhost:5173").replace(/\/$/, "");

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(label: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Console errors + failed responses, so a working-looking page that throws fails. */
interface Noise {
  console: string[];
  pageErrors: string[];
  badResponses: string[];
  api: { method: string; url: string; status: number }[];
}

function watch(page: Page): Noise {
  const n: Noise = { console: [], pageErrors: [], badResponses: [], api: [] };
  page.on("console", (m) => {
    if (m.type() === "error") n.console.push(`${m.text()} @ ${m.location().url}`);
  });
  page.on("pageerror", (e) => n.pageErrors.push(e.message));
  page.on("requestfailed", (r: Request) => {
    // Aborted navigations and HMR sockets are noise, not failures.
    const why = r.failure()?.errorText ?? "";
    if (!/ERR_ABORTED|net::ERR_FAILED$/.test(why) || /\/api\//.test(r.url())) {
      n.badResponses.push(`${r.method()} ${r.url()} — ${why}`);
    }
  });
  page.on("response", (r: Response) => {
    const url = r.url();
    if (!/\/api\/v1\//.test(url)) return;
    n.api.push({ method: r.request().method(), url, status: r.status() });
    if (r.status() >= 400) n.badResponses.push(`${r.request().method()} ${url} → ${r.status()}`);
  });
  return n;
}

async function login(page: Page, email: string) {
  await page.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", PASSWORD);
  const res = page.waitForResponse((r) => r.url().endsWith("/auth/login"), { timeout: 30_000 });
  await page.click("button[type=submit]");
  const r = await res.catch(() => null);
  try {
    await page.waitForURL("**/app/**", { timeout: 30_000 });
  } catch (e) {
    // The failure is nearly always the login POST, not the navigation — say
    // which, instead of leaving a bare timeout on a URL pattern.
    console.error(
      `login(${email}) failed: POST /auth/login → ${r?.status() ?? "no response"} ` +
        `${(await r?.text().catch(() => ""))?.slice(0, 200) ?? ""}`,
    );
    throw e;
  }
}

/** Does the page scroll sideways? The single most visible responsive bug. */
async function hasHScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

async function main() {
  console.log(`Calls UI check against ${WEB} (api ${BASE.msg})\n`);

  // ── Real data to render ───────────────────────────────────────────────────
  const alice = await createOrgOrLogin("Acme", "acme", "alice@acme.com", "Alice Admin");
  const bob = await inviteAndAccept(alice, "bob@acme.com", "bob", "Bob Builder");
  const stamp = Date.now();
  const upcomingTitle = `UI upcoming ${stamp}`;
  const liveTitle = `UI live ${stamp}`;

  const upcoming: any = await api(BASE.msg, "/api/v1/meetings", {
    token: alice.accessToken,
    body: {
      title: upcomingTitle,
      media: "video",
      scheduledAt: new Date(stamp + 2 * 3_600_000).toISOString(),
      inviteeIds: [bob.user.id],
    },
  });
  const liveCall: any = await api(BASE.msg, "/api/v1/meetings", {
    token: alice.accessToken,
    body: { title: liveTitle, media: "audio", inviteeIds: [bob.user.id] },
  });
  await api(BASE.msg, `/api/v1/calls/${liveCall.id}/start`, { token: alice.accessToken, method: "POST" });
  // A conversation to open, so the chat header (and its call control) exists.
  await api(BASE.msg, "/api/v1/conversations", { token: alice.accessToken, body: { peerId: bob.user.id } });
  console.log(`seeded: upcoming=${upcoming.id} live=${liveCall.id}\n`);

  const browser: Browser = await chromium.launch({
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const noise = watch(page);

  await login(page, "alice@acme.com");

  // ── 1. MEETINGS: the rail entry ───────────────────────────────────────────
  console.log("1. Meetings — sidebar entry");
  const railLabels = await page
    .locator("nav button")
    .evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
  ok("the rail has a Meetings entry", railLabels.includes("Meetings"), railLabels.join(" | "));
  ok(
    "…directly below Inbox",
    railLabels.indexOf("Meetings") === railLabels.indexOf("Inbox") + 1,
    railLabels.join(" | "),
  );
  {
    // lucide stamps the icon name as a class, so the calendar is checkable
    // without matching on a path `d` attribute.
    const cls = await page
      .locator("nav button", { hasText: "Meetings" })
      .first()
      .locator("svg")
      .first()
      .getAttribute("class");
    ok("…with a calendar icon", /calendar/i.test(cls ?? ""), String(cls));
  }

  // ── 2. MEETINGS: the page ─────────────────────────────────────────────────
  console.log("\n2. Meetings — the page");
  const callsReq = page.waitForResponse(
    (r) => /\/api\/v1\/calls(\?|$)/.test(r.url()) && r.request().method() === "GET",
    { timeout: 20_000 },
  );
  await page.locator("nav button", { hasText: "Meetings" }).first().click();
  const callsRes = await callsReq.catch(() => null);
  ok("clicking it navigates to /app/meetings", page.url().endsWith("/app/meetings"), page.url());
  ok("…and it fetches GET /api/v1/calls", !!callsRes, "no request observed");
  ok("…which answers 200", callsRes?.status() === 200, String(callsRes?.status()));

  const served: any[] = callsRes ? await callsRes.json().catch(() => []) : [];
  ok("…with real rows, not an empty stub", served.length > 0, `${served.length} rows`);

  await page.waitForTimeout(600);
  const body = await page.locator("main, body").first().innerText();
  ok("the page header says Meetings", /Meetings/.test(body));
  ok("it offers Upcoming / Live / Past", /Upcoming/.test(body) && /Live/.test(body) && /Past/.test(body));
  ok("the UPCOMING meeting the API returned is on screen", body.includes(upcomingTitle));
  ok(
    "…and its title is the SERVER's, not a hardcoded sample",
    served.some((c) => c.title === upcomingTitle),
  );
  {
    // Switch to Live and check the other seeded row — proves the tabs filter on
    // the fetched status rather than on a static list.
    await page.getByRole("tab", { name: /^Live/ }).first().click();
    await page.waitForTimeout(400);
    const liveBody = await page.locator("main, body").first().innerText();
    ok("the Live tab shows the started meeting", liveBody.includes(liveTitle), liveBody.slice(0, 300));
    ok("…and not the one that has not started", !liveBody.includes(upcomingTitle));
  }
  {
    await page.getByRole("tab", { name: /^Upcoming/ }).first().click();
    await page.waitForTimeout(300);
    const n = await page.getByRole("button", { name: "New meeting" }).count();
    ok("there is a way to schedule a new meeting", n > 0);
  }
  {
    // No second request storm: opening the page must not re-fetch on every
    // render. Count the /calls GETs since navigation.
    const gets = noise.api.filter((a) => a.method === "GET" && /\/api\/v1\/calls(\?|$)/.test(a.url));
    ok("the list is fetched once, not in a loop", gets.length <= 2, `${gets.length} GET /calls`);
  }

  // ── 2c. The INVITEE's view: the waiting room, and the live update ─────────
  //
  // This is the half of Meetings that only exists for somebody who is NOT the
  // organiser, and it is where two real bugs lived: the Join button asked the
  // server to START a call, which is a 403 for a participant; and the list
  // never heard `call.started`, so it kept saying "Upcoming" about a meeting
  // that was already running.
  console.log("\n2c. Meetings — an invitee, and a host opening the call");
  const bobCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const bobPage = await bobCtx.newPage();
  const bobNoise = watch(bobPage);
  const scheduledTitle = `UI lobby ${stamp}`;
  // Two meetings, because leaving a call takes you off its notification list
  // (`left_at IS NULL` decides who a lifecycle event is addressed to). One is
  // for the waiting room, which has to be entered and left; the other is only
  // ever looked at from the list, which is what the live-update check needs.
  const pendingTitle = `UI pending ${stamp}`;
  const scheduled: any = await api(BASE.msg, "/api/v1/meetings", {
    token: alice.accessToken,
    body: {
      title: scheduledTitle,
      media: "video",
      scheduledAt: new Date(stamp + 60_000).toISOString(),
      inviteeIds: [bob.user.id],
    },
  });
  const pending: any = await api(BASE.msg, "/api/v1/meetings", {
    token: alice.accessToken,
    body: {
      title: pendingTitle,
      media: "video",
      scheduledAt: new Date(stamp + 90_000).toISOString(),
      inviteeIds: [bob.user.id],
    },
  });
  await login(bobPage, "bob@acme.com");
  await bobPage.locator("nav button", { hasText: "Meetings" }).first().click();
  await bobPage.waitForTimeout(1500);
  {
    const t = await bobPage.locator("main, body").first().innerText();
    ok("the invitee sees the meeting under Upcoming", t.includes(scheduledTitle), t.slice(0, 300));
  }
  {
    // Join, on a call that has not been opened: the waiting room, NOT an error
    // toast, and NOT a Start control this user may not use.
    const tokenReq = bobPage.waitForResponse((r) => /\/token$/.test(r.url()), { timeout: 20_000 });
    await bobPage
      .locator("div.glass")
      .filter({ hasText: scheduledTitle })
      .first()
      .getByRole("button", { name: /^(Join|Start)$/ })
      .click();
    const tok = await tokenReq.catch(() => null);
    ok("…and opening it asks for a room token", !!tok);
    ok("…which answers 202, the waiting room", tok?.status() === 202, String(tok?.status()));
    const startAttempts = bobNoise.api.filter((a) => /\/start$/.test(a.url));
    ok("…and does NOT try to start a call this user may not open", startAttempts.length === 0);
    await bobPage.waitForTimeout(1200);
    const t = await bobPage.locator("body").innerText();
    ok("the invitee is shown a waiting room, not an endless 'Connecting…'", /hasn't been opened yet/i.test(t), t.slice(0, 400));
    ok("…with no Start control", (await bobPage.getByRole("button", { name: "Start now" }).count()) === 0);
    ok("…and a way out", (await bobPage.getByRole("button", { name: "Leave" }).count()) === 1);
  }
  {
    // Still in the lobby: the host opening the call has to end the wait by
    // itself. This is the `call.started` subscription the hook takes out while
    // it waits, and it is what makes the lobby cost nothing while it sits there.
    await api(BASE.msg, `/api/v1/calls/${scheduled.id}/start`, {
      token: alice.accessToken,
      method: "POST",
    });
    const left = await bobPage
      .getByText(/hasn't been opened yet/i)
      .waitFor({ state: "detached", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    ok("the host opening it ends the wait without the user doing anything", left);
  }
  {
    // Back to the list. The OTHER meeting — never opened, so this browser is
    // still on its notification list — must move from Upcoming to Live on the
    // event alone, with no reload and no navigation.
    await bobPage.goto(`${WEB}/app/meetings`, { waitUntil: "domcontentloaded" });
    await bobPage.waitForTimeout(1500);
    const before = bobNoise.api.filter((a) => a.method === "GET" && /\/api\/v1\/calls(\?|$)/.test(a.url)).length;
    const refetch = bobPage.waitForResponse(
      (r) => /\/api\/v1\/calls(\?|$)/.test(r.url()) && r.request().method() === "GET",
      { timeout: 20_000 },
    );
    await api(BASE.msg, `/api/v1/calls/${pending.id}/start`, {
      token: alice.accessToken,
      method: "POST",
    });
    const re = await refetch.catch(() => null);
    ok("the host opening it makes the invitee's list refetch", !!re, "no refetch seen");
    ok(
      "…without a reload",
      bobNoise.api.filter((a) => a.method === "GET" && /\/api\/v1\/calls(\?|$)/.test(a.url)).length > before,
    );
    await bobPage.waitForTimeout(1200);
    await bobPage.getByRole("tab", { name: /^Live/ }).first().click();
    await bobPage.waitForTimeout(600);
    const t = await bobPage.locator("main, body").first().innerText();
    ok("…and the meeting has moved to Live", t.includes(pendingTitle), t.slice(0, 400));
    const upcoming = await bobPage.getByRole("tab", { name: /^Upcoming/ }).first().innerText();
    ok("…and out of Upcoming", !upcoming.includes(pendingTitle));
  }
  for (const id of [scheduled.id, pending.id]) {
    await api(BASE.msg, `/api/v1/calls/${id}/end`, { token: alice.accessToken, method: "POST" }).catch(() => {});
  }
  await bobCtx.close();

  // ── 3. CALL DROPDOWN ──────────────────────────────────────────────────────
  console.log("\n3. Call dropdown in a chat");
  await page.locator("nav button", { hasText: "Chats" }).first().click();
  await page.waitForTimeout(800);
  await page.locator("aside, [class*=w-]").getByText("Bob Builder").first().click({ timeout: 15_000 });
  await page.waitForURL("**/app/chats/**", { timeout: 15_000 });
  await page.waitForTimeout(600);

  // The DM header, not the app navbar above it — both are <header>.
  const header = page.locator("header").filter({ hasText: "Bob Builder" }).first();
  {
    const callTriggers = await header.getByRole("button", { name: "Call" }).count();
    ok("the chat header has exactly ONE call control", callTriggers === 1, `${callTriggers} found`);
  }
  {
    // "Only one call icon" is a claim about the header as a whole: no stray
    // second phone or video button beside it.
    const names = await header
      .locator("button")
      .evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") || e.textContent || "").trim()));
    const callish = names.filter((n) => /call|phone|video/i.test(n));
    ok("…and no other phone/video button beside it", callish.length === 1, names.join(" | "));
  }

  await header.getByRole("button", { name: "Call" }).click();
  await page.waitForTimeout(250);
  const menu = page.locator('[role="menu"]');
  ok("clicking it opens a menu", (await menu.count()) === 1);
  const items = menu.getByRole("menuitem");
  const itemText = await items.evaluateAll((els) => els.map((e) => (e.textContent ?? "").trim()));
  ok("the menu has exactly FOUR options", itemText.length === 4, itemText.join(" | "));
  ok("…Voice Call", /voice call/i.test(itemText[0] ?? ""), itemText[0]);
  ok("…Video Call", /video call/i.test(itemText[1] ?? ""), itemText[1]);
  ok("…Send Link", /send.*link/i.test(itemText[2] ?? ""), itemText[2]);
  ok("…Schedule Call", /schedule call/i.test(itemText[3] ?? ""), itemText[3]);
  {
    const icons = await items.evaluateAll((els) => els.map((e) => e.querySelectorAll("svg").length));
    ok("every option carries an icon", icons.every((c) => c === 1), icons.join(","));
    const cls = await items.evaluateAll((els) =>
      els.map((e) => e.querySelector("svg")?.getAttribute("class") ?? ""),
    );
    ok("…a phone on Voice", /phone/i.test(cls[0] ?? ""), cls[0]);
    ok("…a camera on Video", /video/i.test(cls[1] ?? ""), cls[1]);
    ok("…a link on Send Link", /link/i.test(cls[2] ?? ""), cls[2]);
    ok("…a calendar on Schedule", /calendar/i.test(cls[3] ?? ""), cls[3]);
  }
  {
    // aria, so the menu is operable by a screen reader and not just a mouse.
    const trigger = header.getByRole("button", { name: "Call" });
    ok("the trigger reports it is expanded", (await trigger.getAttribute("aria-expanded")) === "true");
  }

  // Schedule Call → the dialog, and nothing else.
  await items.nth(3).click();
  await page.waitForTimeout(400);
  {
    const t = await page.locator("body").innerText();
    ok("Schedule Call opens the scheduler", /Schedule a call/i.test(t), t.slice(0, 200));
    await page.getByRole("button", { name: "Cancel" }).first().click();
    await page.waitForTimeout(300);
    ok("…and the menu is closed behind it", (await page.locator('[role="menu"]').count()) === 0);
  }

  // Send Call Link → two real requests and a message in the thread.
  console.log("\n3b. Send Call Link — the request chain");
  {
    await header.getByRole("button", { name: "Call" }).click();
    await page.waitForTimeout(200);
    // .catch attached at creation: these are armed BEFORE the click, and a
    // rejection that lands while the click is still awaiting would otherwise be
    // an unhandled rejection that kills the run instead of failing a check.
    const meetingReq = page
      .waitForResponse((r) => r.url().endsWith("/api/v1/meetings") && r.request().method() === "POST", {
        timeout: 25_000,
      })
      .catch(() => null);
    const inviteReq = page
      .waitForResponse((r) => /\/invites$/.test(r.url()) && r.request().method() === "POST", {
        timeout: 25_000,
      })
      .catch(() => null);
    await page.locator('[role="menu"]').getByRole("menuitem").nth(2).click();
    const m = await meetingReq;
    const inv = await inviteReq;
    ok("it creates a meeting → 201", m?.status() === 201, String(m?.status()));
    ok("…with the peer already on the roster", JSON.parse(m?.request().postData() ?? "{}").inviteeIds?.length === 1);
    ok("…then mints an invite link → 201", inv?.status() === 201, String(inv?.status()));
    await page.waitForTimeout(1200);
    const thread = await page.locator("body").innerText();
    ok("…and posts the join link into the chat", /Join my call: .*\/join\?t=/.test(thread));
  }

  // ── 4. ACTIVE CALL CONTROLS + SCREEN SHARING ──────────────────────────────
  console.log("\n4. In-call controls and screen sharing");
  const preview = await ctx.newPage();
  const previewNoise = watch(preview);
  await preview.goto(`${WEB}/call-preview.html`, { waitUntil: "domcontentloaded" });
  await preview.waitForTimeout(800);

  // The overlay set (CallUI) is the first control row on the page.
  const row = preview.locator("div.z-10.flex.items-center.justify-center").first();
  {
    const names = await row
      .locator("button")
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
    ok("the call shows five icon-only controls", names.length === 5, names.join(" | "));
    ok("…Add People", names.some((n) => /add people/i.test(n)));
    ok("…Share Screen", names.some((n) => /share your screen/i.test(n)));
    ok("…Mute", names.some((n) => /^mute$|unmute/i.test(n)));
    ok("…Camera on/off", names.some((n) => /camera/i.test(n)));
    ok("…End Call", names.some((n) => /end call/i.test(n)));
    const labelled = await row
      .locator("button")
      .evaluateAll((els) => els.every((e) => (e.textContent ?? "").trim() === ""));
    ok("…and they are icons, with no visible text label", labelled);
  }

  const share = row.getByRole("button", { name: "Share your screen" });
  await share.click();
  await preview.waitForTimeout(700);
  {
    const stop = row.getByRole("button", { name: "Stop sharing your screen" });
    ok("sharing turns the share control red", (await stop.count()) === 1);
    const cls = (await stop.getAttribute("class")) ?? "";
    ok("…literally red, not merely 'pressed'", /red-500/.test(cls), cls);
    ok("…and it grows a timer", /\d+:\d\d/.test((await stop.innerText()) ?? ""), await stop.innerText());
    ok("…and reports its pressed state", (await stop.getAttribute("aria-pressed")) === "true");
  }
  // The preview renders BOTH in-call surfaces (the overlay and the room footer)
  // off one `sharing` flag, so every popup assertion is scoped to the overlay —
  // otherwise "the panel is gone" is answered by the other section's panel.
  const overlay = preview.locator("section").first();
  const panel = overlay.locator('[role="status"]');
  {
    ok("a popup says sharing is active", /sharing your screen/i.test(await panel.innerText()));
    const stopBtn = overlay.getByRole("button", { name: "Stop sharing", exact: true });
    ok("…with a Stop button", (await stopBtn.count()) === 1);
    const cls = (await stopBtn.getAttribute("class")) ?? "";
    ok("…which is red", /bg-red-500/.test(cls), cls);
    ok("…and the panel has a timer of its own", /\d+:\d\d/.test(await panel.innerText()));
  }
  {
    // Collapse → side tab → restore. The panel deliberately has no close.
    ok(
      "the panel cannot be dismissed, only slid away",
      (await overlay.getByRole("button", { name: /close|dismiss/i }).count()) === 0,
    );
    await overlay.getByRole("button", { name: "Slide out of the way" }).click();
    // AnimatePresence mode="wait": the panel's exit spring has to finish before
    // the tab mounts, so this waits for the swap rather than a fixed frame.
    await overlay.getByRole("button", { name: "Show screen sharing controls" }).waitFor({ timeout: 5_000 });
    const tab = overlay.getByRole("button", { name: "Show screen sharing controls" });
    ok("collapsing leaves a side icon", (await tab.count()) === 1);
    ok("…and the panel is gone", (await panel.count()) === 0);
    await tab.click();
    await panel.waitFor({ timeout: 5_000 });
    ok("clicking the side icon restores the popup", (await panel.count()) === 1);
    ok("…and the side icon is gone again", (await tab.count()) === 0);
  }
  {
    await overlay.getByRole("button", { name: "Stop sharing", exact: true }).click();
    await preview.waitForTimeout(500);
    ok("Stop ends the share", (await panel.count()) === 0);
    ok(
      "…and the control goes back to offering it",
      (await row.getByRole("button", { name: "Share your screen" }).count()) === 1,
    );
  }
  {
    const mic = row.getByRole("button", { name: "Mute" });
    await mic.click();
    await preview.waitForTimeout(250);
    ok("Mute toggles to Unmute", (await row.getByRole("button", { name: "Unmute" }).count()) === 1);
    const cam = row.getByRole("button", { name: /camera/i }).first();
    const before = await cam.getAttribute("aria-label");
    await cam.click();
    await preview.waitForTimeout(250);
    const after = await row.locator("button").nth(3).getAttribute("aria-label");
    ok("the camera control toggles too", before !== after, `${before} → ${after}`);
  }

  // ── 5. RESPONSIVE ─────────────────────────────────────────────────────────
  console.log("\n5. Responsive");
  for (const [w, h, label] of [
    [1440, 900, "desktop"],
    [1280, 720, "laptop"],
    [1024, 768, "tablet landscape"],
    [768, 1024, "tablet portrait"],
  ] as [number, number, string][]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${WEB}/app/meetings`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    ok(`Meetings does not scroll sideways at ${w}×${h} (${label})`, !(await hasHScroll(page)));
    const visible = await page.getByText(upcomingTitle).first().isVisible().catch(() => false);
    ok(`…and still lists its meetings at ${w}×${h}`, visible);
  }
  {
    // The chat header is the tightest row in the app: name, presence, call,
    // Block, Ignore. Squeezing it is what used to push the call button off.
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(`${WEB}/app/chats`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    await page.getByText("Bob Builder").first().click();
    await page.waitForTimeout(900);
    ok("the chat does not scroll sideways on a tablet", !(await hasHScroll(page)));
    const trigger = page.locator("header").filter({ hasText: "Bob Builder" }).first()
      .getByRole("button", { name: "Call" });
    ok("…and the call control is still reachable", await trigger.isVisible());
    await trigger.click();
    await page.waitForTimeout(250);
    const n = await page.locator('[role="menu"]').getByRole("menuitem").count();
    ok("…and still opens four options", n === 4, String(n));
  }

  // ── 6. Console + network hygiene ──────────────────────────────────────────
  console.log("\n6. Console / network");
  // Known-environmental noise on this dev stack, and why each one is not a
  // finding: the session bootstrap always probes /auth/refresh before there is a
  // session; telemetry-svc is not running here; and the auth-svc / ws-gateway
  // containers predate two routes the current source serves. Anything NOT in
  // this list is a real console error and fails the run.
  const ENVIRONMENTAL =
    /auth\/refresh|telemetry\/beacon|auth\/orgs\/mine|presence\/query|ERR_CONNECTION_REFUSED/;
  const allNoise = [...noise.console, ...previewNoise.console, ...bobNoise.console].filter((m) => !ENVIRONMENTAL.test(m));
  const allErrors = [...noise.pageErrors, ...previewNoise.pageErrors, ...bobNoise.pageErrors];
  const allBad = [...noise.badResponses, ...previewNoise.badResponses, ...bobNoise.badResponses].filter(
    // ERR_ABORTED is the read-receipt POST losing a race with a navigation this
    // script performs deliberately; it is not a call-surface failure.
    (m) => !ENVIRONMENTAL.test(m) && !/ERR_ABORTED/.test(m),
  );
  ok("no uncaught page errors", allErrors.length === 0, allErrors.join(" | "));
  ok("no console errors", allNoise.length === 0, allNoise.slice(0, 5).join(" | "));
  ok("no failed API responses", allBad.length === 0, allBad.slice(0, 5).join(" | "));

  await browser.close();
  await api(BASE.msg, `/api/v1/calls/${liveCall.id}/end`, { token: alice.accessToken, method: "POST" }).catch(
    () => {},
  );
  await api(BASE.msg, `/api/v1/calls/${upcoming.id}/end`, { token: alice.accessToken, method: "POST" }).catch(
    () => {},
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log("failures:\n  - " + failures.join("\n  - "));
    process.exit(1);
  }
}

void ((): Session | undefined => undefined)();

main().catch((e) => {
  console.error("\nUI check aborted:", e);
  process.exit(2);
});
