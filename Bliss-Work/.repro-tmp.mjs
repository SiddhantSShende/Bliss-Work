import { chromium } from "playwright";

const BASE = "http://localhost:5173";
const EMAIL = "alice@acme.com";
const PASSWORD = "Passw0rd!9";

function wireLogging(page, label) {
  page.on("console", (msg) => {
    console.log(`[${label}][console.${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    console.log(`[${label}][pageerror] ${err.message}\n${err.stack}`);
  });
  page.on("requestfailed", (req) => {
    console.log(`[${label}][requestfailed] ${req.method()} ${req.url()} -> ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    const url = res.url();
    if (url.includes("/token") || url.includes("/calls/") || url.includes("CallRoom") || url.includes("CallWindow")) {
      console.log(`[${label}][response] ${res.status()} ${url}`);
    }
  });
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const context = await browser.newContext();
const page = await context.newPage();
wireLogging(page, "main");

console.log("=== Navigating to login ===");
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1000);

// Try to find and fill the login form
try {
  await page.fill('input[type="email"], input[name="email"]', EMAIL, { timeout: 10000 });
  await page.fill('input[type="password"], input[name="password"]', PASSWORD, { timeout: 10000 });
  await page.click('button[type="submit"]');
  console.log("=== Submitted login ===");
} catch (e) {
  console.log("LOGIN FORM FILL FAILED:", e.message);
  console.log("Page content snapshot:", (await page.content()).slice(0, 2000));
}

await page.waitForTimeout(3000);
console.log("=== Current URL after login attempt:", page.url());

// Navigate to Meetings
await page.goto(`${BASE}/app/meetings`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
console.log("=== Meetings page URL:", page.url());
console.log("=== Meetings page body snippet:", (await page.content()).slice(0, 3000));

await browser.close();
