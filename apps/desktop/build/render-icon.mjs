import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const svg = readFileSync(new URL("./icon.svg", import.meta.url), "utf8");
let browser;
for (const c of ["chrome", "msedge", "chromium"]) { try { browser = await chromium.launch({ channel: c, headless: true }); break; } catch {} }
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(`<!doctype html><meta charset=utf8><style>html,body{margin:0;padding:0;background:transparent}</style>${svg}`);
await page.locator("svg").screenshot({ path: new URL("./icon.png", import.meta.url).pathname.replace(/^\//, ""), omitBackground: true });
await browser.close();
console.log("icon.png written");
