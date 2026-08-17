/** Scratch probe: what happens when an invitee opens a not-yet-started meeting. */
import { chromium } from "playwright";
import { BASE, api, createOrgOrLogin, inviteAndAccept, PASSWORD } from "./_tb";

const WEB = process.argv[2] ?? "http://localhost:5173";

async function main() {
  const alice = await createOrgOrLogin("Acme", "acme", "alice@acme.com", "Alice Admin");
  const bob = await inviteAndAccept(alice, "bob@acme.com", "bob", "Bob Builder");
  const title = `LOBBY ${Date.now()}`;
  const call: any = await api(BASE.msg, "/api/v1/meetings", {
    token: alice.accessToken,
    body: {
      title,
      media: "video",
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      inviteeIds: [bob.user.id],
    },
  });
  console.log("meeting", call.id, title);

  const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const p = await (await b.newContext()).newPage();
  p.on("pageerror", (e) => console.log("PAGEERROR:", e.stack?.slice(0, 900) ?? e.message));
  p.on("console", (m) => {
    if (m.type() === "error") console.log("[console]", m.text().slice(0, 300));
  });
  p.on("response", (r) => {
    if (/\/api\/v1\/calls/.test(r.url())) console.log("  API", r.request().method(), r.url().replace(BASE.msg, ""), r.status());
  });

  await p.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
  await p.fill("input[type=email]", "bob@acme.com");
  await p.fill("input[type=password]", PASSWORD);
  await p.click("button[type=submit]");
  await p.waitForURL("**/app/**", { timeout: 30_000 });
  await p.locator("nav button", { hasText: "Meetings" }).first().click();
  await p.waitForTimeout(2000);

  const row = p.locator("div.glass").filter({ hasText: title }).first();
  console.log("row count:", await row.count());
  await row.getByRole("button", { name: /Join|Start/ }).click();
  await p.waitForTimeout(4000);
  console.log("BODY:", (await p.locator("body").innerText()).slice(0, 600));

  await api(BASE.msg, `/api/v1/calls/${call.id}/end`, { token: alice.accessToken, method: "POST" }).catch(() => {});
  await b.close();
}
main();
