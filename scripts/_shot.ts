import { chromium } from "playwright";

const PW = "Passw0rd!";

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("console", (m) => console.log(`[${m.type()}]`, m.text()));
  page.on("pageerror", (e) => console.log("PAGE-CRASH:", e.message));

  await page.goto("http://localhost:5173/login", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: ".shot/01-login.png", fullPage: true });
  console.log("login title:", await page.title());

  // log in as alice
  try {
    await page.fill("input[type=email]", "alice@acme.com");
    await page.fill("input[type=password]", PW);
    await page.click("button[type=submit]");
    await page.waitForURL("**/app/**", { timeout: 20000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: ".shot/02-app.png", fullPage: true });
    console.log("app url:", page.url());
    const body = await page.locator("body").innerText().catch(() => "");
    console.log("\n── BODY TEXT (first 1200) ──\n" + body.slice(0, 1200));
  } catch (e) {
    await page.screenshot({ path: ".shot/02-app-fail.png", fullPage: true });
    console.log("post-login capture failed:", String(e));
  }

  await browser.close();
  console.log("DONE — screenshots in .shot/");
}
main().catch((e) => { console.error("shot crashed:", e); process.exit(1); });
