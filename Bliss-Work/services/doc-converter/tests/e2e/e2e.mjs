// Drives the real stack started by run.sh. Plain Node, no dependencies.
import { execFileSync, spawnSync } from "node:child_process";
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// ONLY_BROWSER=1 skips sections 2–7 (and converts just docx/xlsx in 1) to iterate on section 8 quickly.
const quick = process.env.ONLY_BROWSER === "1";
const { MSG, WORK, MEDIA_ROOT, FIXTURE_DIR, LARGE_FIXTURE_DIR, PGCONTAINER, CONVCONTAINER } = process.env;
const key = createPrivateKey(readFileSync(`${WORK}/key.pem`));
const b64 = (b) => Buffer.from(b).toString("base64url");
const fx = (n) => readFileSync(`${FIXTURE_DIR}/${n}`);
const big = (n) => readFileSync(`${LARGE_FIXTURE_DIR}/${n}`);
const docker = (...a) => execFileSync("sudo", ["-n", "docker", ...a], { encoding: "utf8" });

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
};
const section = (s) => console.log(`\n${s}`);

// ── identity ────────────────────────────────────────────────────────────────
const org = randomUUID(), other = randomUUID();
const users = { ada: randomUUID(), grace: randomUUID(), rival: randomUUID(), stranger: randomUUID() };
const channel = randomUUID();
const token = (user, orgId) => {
  const head = b64('{"alg":"EdDSA","typ":"JWT","kid":"t"}');
  const now = Math.floor(Date.now() / 1000);
  const body = b64(JSON.stringify({ iss: "task-board", sub: user, org_id: orgId, username: "u", roles: ["member"], iat: now, exp: now + 3600 }));
  return `${head}.${body}.${b64(sign(null, Buffer.from(`${head}.${body}`), key))}`;
};
const T = { ada: token(users.ada, org), grace: token(users.grace, org), rival: token(users.rival, org), stranger: token(users.stranger, other) };

const sql = (text) =>
  execFileSync("sudo", ["-n", "docker", "exec", "-i", PGCONTAINER, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "messaging_user", "-d", "e2e", "-1",
    "-c", "SELECT set_config('app.bypass_rls','on',true)", "-f", "-"], { input: text, encoding: "utf8" });
sql(`
INSERT INTO user_projection (user_id, org_id, username, display_name) VALUES
 ('${users.ada}','${org}','ada','ada'),('${users.grace}','${org}','grace','grace'),
 ('${users.rival}','${org}','rival','rival'),('${users.stranger}','${other}','stranger','stranger');
INSERT INTO channels (id, org_id, name, created_by) VALUES ('${channel}','${org}','general','${users.ada}');
INSERT INTO channel_members (channel_id, org_id, user_id) VALUES
 ('${channel}','${org}','${users.ada}'),('${channel}','${org}','${users.grace}');`);

// ── api ─────────────────────────────────────────────────────────────────────
async function upload(who, name, bytes, scopeId = channel) {
  const fd = new FormData();
  fd.append("file", new Blob([bytes]), name);
  const r = await fetch(`${MSG}/api/v1/attachments?scope=channel&scopeId=${scopeId}`, { method: "POST", headers: { authorization: `Bearer ${T[who]}` }, body: fd });
  if (!r.ok) throw new Error(`upload ${name}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function link(who, id) {
  const r = await fetch(`${MSG}/api/v1/attachments/links`, { method: "POST", headers: { authorization: `Bearer ${T[who]}`, "content-type": "application/json" }, body: JSON.stringify({ ids: [id] }) });
  const body = await r.json();
  return (Array.isArray(body) ? body : body.links ?? [])[0]?.url;
}
const previewOf = (url) => MSG + url.replace("?t=", "/preview?t=");
async function get(url) {
  const t0 = Date.now();
  const r = await fetch(url);
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, h: r.headers, buf, ms: Date.now() - t0, text: () => buf.toString("utf8") };
}
/** Asks again on 202, as the app does. */
async function poll(url, maxMs = 180_000) {
  const t0 = Date.now(); let polls = 0, last;
  for (;;) {
    last = await get(url);
    if (last.status !== 202) return { ...last, polls, total: Date.now() - t0 };
    polls++;
    if (Date.now() - t0 > maxMs) return { ...last, polls, total: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 1000));
  }
}
// The sandbox logs to stderr, which `docker logs` re-emits on ITS stderr — read both,
// or this counts zero forever and every "was not called again" check passes vacuously.
const conversions = () => {
  const r = spawnSync("sudo", ["-n", "docker", "logs", CONVCONTAINER], { encoding: "utf8" });
  return ((r.stdout + r.stderr).match(/"event":"convert"/g) ?? []).length;
};
const derived = (att, ext) => `${MEDIA_ROOT}/blobs/${org}/${att.sha256.slice(0, 2)}/${att.sha256.slice(2, 4)}/${att.sha256}.v1.${ext}`;
const distinct = (buf, tag) => Buffer.concat([buf, Buffer.from(`\n<!-- ${tag} ${randomUUID()} -->`)]); // trailing bytes: a new sha, still a valid container

// ── 1. all six formats, end to end ──────────────────────────────────────────
section("1. Word, PowerPoint and Excel, converted by the real sandbox");
const atts = {};
for (const kind of quick ? ["docx", "xlsx"] : ["doc", "docx", "ppt", "pptx", "xls", "xlsx"]) {
  const att = (atts[kind] = await upload("ada", `Fixture.${kind}`, fx(`fixture.${kind}`)));
  const url = await link("grace", att.id);
  const r = await poll(previewOf(url));
  const isPdf = ["doc", "docx", "ppt", "pptx"].includes(kind);
  check(`${kind}: stored mime is '${att.mime}' (the client must go by extension)`, !att.mime.includes("officedocument") && !att.mime.includes("msword"));
  check(`${kind}: 200 after ${r.polls} poll(s), ${r.total} ms`, r.status === 200, `status ${r.status}`);
  if (isPdf) {
    check(`${kind}: a real PDF, served inline`, r.buf.subarray(0, 5).toString() === "%PDF-" && r.h.get("content-type") === "application/pdf" && /^inline/.test(r.h.get("content-disposition") ?? ""));
  } else {
    let j; try { j = JSON.parse(r.text()); } catch { /* checked below */ }
    check(`${kind}: sheets JSON in workbook order, as an attachment`, j?.sheets?.[0]?.name === "Zulu" && j.sheets[1]?.name === "Beta ünï" && j.sheets[0].csv.includes("FIXTURE-SHEET-MARKER,2,3,5") &&
      /^attachment/.test(r.h.get("content-disposition") ?? "") && r.h.get("content-type") === "application/octet-stream");
  }
  check(`${kind}: nosniff and a sandboxing CSP on the response`, r.h.get("x-content-type-options") === "nosniff" && /sandbox/.test(r.h.get("content-security-policy") ?? ""));
  check(`${kind}: derivative stored beside the original under the org`, existsSync(derived(att, isPdf ? "pdf" : "json")));
}

if (!quick) {
check("the conversion counter works (6 conversions so far)", conversions() >= 6, `counted ${conversions()}`);

// ── 2. cache ────────────────────────────────────────────────────────────────
section("2. Cache: a second request does not convert again");
{
  const before = conversions();
  const url = await link("grace", atts.docx.id);
  const r = await get(previewOf(url));
  check(`cache hit is 200 in ${r.ms} ms`, r.status === 200 && r.ms < 2000);
  check("the sandbox was not called again", conversions() === before, `${before} → ${conversions()}`);
}

// ── 3. single flight ────────────────────────────────────────────────────────
section("3. Six simultaneous requests for one uncached document share one conversion");
{
  const att = await upload("ada", "Long.docx", big("doc200p.docx"));
  const url = await link("grace", att.id);
  const before = conversions();
  const rs = await Promise.all(Array.from({ length: 6 }, () => poll(previewOf(url))));
  check("all six end in a PDF", rs.every((r) => r.status === 200 && r.buf.subarray(0, 5).toString() === "%PDF-"), rs.map((r) => r.status).join(","));
  check("exactly one conversion ran", conversions() - before === 1, `ran ${conversions() - before}`);
}

// ── 4. slow conversion → 202 polling ────────────────────────────────────────
section("4. A big spreadsheet takes longer than the wait window: 202, then 200");
{
  const att = await upload("ada", "Wide.xlsx", big("sheet64k_wide.xlsx"));
  const url = await link("grace", att.id);
  const r = await poll(previewOf(url));
  check(`became ready after ${r.polls} 202(s) in ${(r.total / 1000).toFixed(0)} s`, r.status === 200, `status ${r.status}`);
  check("at least one 202 (Retry-After set) was served while it converted", r.polls >= 1, `${r.polls}`);
  const j = JSON.parse(r.text());
  check(`the artifact is capped and says so (${j.sheets[0].rows ?? j.sheets[0].csv.split("\n").length} rows of ${j.sheets[0].totalRows})`, j.sheets[0].truncated === true && j.sheets[0].csv.split("\n").length <= 5002);
  check("the artifact is far smaller than the 50 MB workbook", r.buf.length < 16 * 1024 * 1024, `${r.buf.length}`);
}

// ── 5. hostile input through the real server ────────────────────────────────
section("5. Hostile input");
{
  const exe = Buffer.concat([Buffer.from("MZ\x90\x00"), Buffer.alloc(4096)]);
  const cases = [
    ["a renamed executable (.docx)", "setup.docx", exe, 415],
    ["an executable named .xlsx", "payroll.xlsx", exe, 415],
    ["OLE bytes named .docx", "x.docx", fx("fixture.doc"), 415],
    ["ZIP bytes named .doc", "x.doc", fx("fixture.docx"), 415],
    ["an .rtf", "letter.rtf", Buffer.from("{\\rtf1 hello}"), 415],
    ["a .zip archive", "assets.zip", fx("fixture.docx"), 415],
    ["an .odt", "a.odt", fx("fixture.docx"), 415],
    ["a macro-enabled .docm", "a.docm", fx("fixture.docx"), 415],
  ];
  const before = conversions();
  for (const [label, name, bytes, want] of cases) {
    const att = await upload("ada", name, bytes);
    const r = await get(previewOf(await link("grace", att.id)));
    check(`${label} → ${want}`, r.status === want, `got ${r.status}`);
  }
  check("none of them reached the sandbox", conversions() === before, `${before} → ${conversions()}`);

  // Corrupt: refused by the sandbox, remembered, never retried.
  const corrupt = await upload("ada", "Corrupt.docx", fx("fixture.docx").subarray(0, 300));
  const curl = previewOf(await link("grace", corrupt.id));
  const c1 = await poll(curl);
  check("a truncated .docx → 422 preview_failed", c1.status === 422 && c1.text().includes("preview_failed"), `${c1.status} ${c1.text().slice(0, 80)}`);
  const afterFirst = conversions();
  const c2 = await get(curl);
  check("asked again: still 422, and the sandbox is not asked again", c2.status === 422 && conversions() === afterFirst);
  check("the error says nothing about the document", !/Corrupt|docx|\.docx/i.test(c1.text()));

  // Zip bomb: a real one, built by python.
  const bombPath = `${WORK}/bomb.docx`;
  execFileSync("python3", ["-c", `import zipfile; z=zipfile.ZipFile(${JSON.stringify(bombPath)},'w',zipfile.ZIP_DEFLATED); z.writestr('word/document.xml', b'\\0'*(8*1024*1024)); z.close()`]);
  const bomb = await upload("ada", "Bomb.docx", readFileSync(bombPath));
  const b = await poll(previewOf(await link("grace", bomb.id)));
  check(`a zip bomb (${(readFileSync(bombPath).length / 1024).toFixed(0)} KB → 8 MB) → 422`, b.status === 422, `got ${b.status}`);
}

// ── 6. authorization, on every request ─────────────────────────────────────
section("6. Authorization");
{
  const att = atts.docx;
  check("an org member NOT in the channel is minted no link", (await link("rival", att.id)) === undefined);
  check("a user from another org is minted no link", (await link("stranger", att.id)) === undefined);

  const good = await link("grace", att.id);
  const tampered = good.slice(0, -3) + "AAA";
  check("a tampered token → 403", (await get(previewOf(tampered))).status === 403);
  check("no token → 403", (await get(`${MSG}/media/${att.id}/preview`)).status === 403);
  const otherLink = await link("grace", atts.doc.id);
  check("another attachment's token on this attachment → 403", (await get(`${MSG}/media/${att.id}/preview?t=${otherLink.split("t=")[1]}`)).status === 403);

  // The preview is cached (section 1/2). Remove grace from the channel: her old link must die.
  check("before removal: the cached preview is served to her", (await get(previewOf(good))).status === 200);
  sql(`DELETE FROM channel_members WHERE channel_id='${channel}' AND user_id='${users.grace}';`);
  const after = await get(previewOf(good));
  check(`after she leaves the channel: refused (${after.status}) although a preview is cached`, after.status !== 200 && !after.buf.subarray(0, 5).toString().startsWith("%PDF"));
  const dl = await get(`${MSG}${good.replace("/preview", "")}`);
  check("(and the plain download is refused the same way)", dl.status !== 200, `${dl.status}`);
  sql(`INSERT INTO channel_members (channel_id, org_id, user_id) VALUES ('${channel}','${org}','${users.grace}');`);
}

// ── 7. sandbox down ─────────────────────────────────────────────────────────
section("7. The sandbox is down: 503, then it recovers");
{
  docker("stop", "-t", "0", CONVCONTAINER);
  const att = await upload("ada", "WhileDown.docx", distinct(fx("fixture.docx"), "down"));
  const url = previewOf(await link("grace", att.id));
  const r = await get(url);
  check("503 with Retry-After while the sandbox is unreachable", r.status === 503 && !!r.h.get("retry-after"), `${r.status}`);
  check("and nothing about it is cached", r.h.get("cache-control") === "no-store");
  docker("start", CONVCONTAINER);
  for (let i = 0; i < 60; i++) { try { if ((await fetch("http://127.0.0.1:19020/healthz")).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
  const again = await poll(url);
  check("once it is back the same link converts", again.status === 200 && again.buf.subarray(0, 5).toString() === "%PDF-", `${again.status}`);
}


}

// ── 8. a REAL browser, the real viewer, the real server ─────────────────────
if (process.env.BROWSER === "1") {
  section("8. Real Chromium: the real AttachmentViewer against the real server (CORS, 202 polling, rendering)");
  const { spawn } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const chromeBin = process.env.CHROME ?? `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell`;
  // A PRIVATE devtools port, never a fixed one: other sessions on this host run their own
  // headless browsers, and a fixed port let two drivers attach to each other's Chromium.
  // Chromium writes the port it actually got into <user-data-dir>/DevToolsActivePort, so
  // everything below talks only to the browser this script launched.
  const userDir = mkdtempSync("/tmp/e2e-chrome-");
  const chrome = spawn(chromeBin, ["--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-sandbox", "--disable-gpu", `--user-data-dir=${userDir}`, "about:blank"], { stdio: "ignore" });
  const cleanupChrome = () => { try { chrome.kill(); } catch { /* gone */ } };
  process.on("exit", cleanupChrome);
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number(readFileSync(`${userDir}/DevToolsActivePort`, "utf8").split("\n")[0]); } catch { /* starting */ }
    if (!port) await new Promise((r) => setTimeout(r, 100));
  }
  if (!port) throw new Error("chromium never wrote DevToolsActivePort");
  // A FRESH TAB PER SCENARIO, never a re-navigated one: navigating a tab that has just shown a
  // PDF (the docx scenario) left its next Page.navigate unanswered in headless Chromium.
  let ws = null, current = null, seq = 0;
  const waiting = new Map();
  const consoleErrors = [];
  const onMessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
    if (d.method === "Runtime.exceptionThrown") consoleErrors.push(d.params.exceptionDetails.text);
  };
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    const t = setTimeout(() => { waiting.delete(id); rej(new Error(`CDP ${method} got no answer in 60 s`)); }, 60_000);
    waiting.set(id, (d) => { clearTimeout(t); res(d); });
    if (process.env.DEBUG_CDP) console.log(`    cdp> ${method} ${method === "Page.navigate" ? params.url.slice(0, 60) : ""}`);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const newTab = async () => {
    if (current) {
      try { ws.close(); } catch { /* closed */ }
      await fetch(`http://127.0.0.1:${port}/json/close/${current.id}`).catch(() => {});
    }
    current = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    ws = new WebSocket(current.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    ws.onmessage = onMessage;
    await cdp("Runtime.enable");
    await cdp("Page.enable");
  };
  const evalJs = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };
  const until = async (expr, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await evalJs(expr); if (v) return v; if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 150)); } };
  const open = async (att, mime, name) => {
    const url = MSG + (await link("grace", att.id));
    const q = new URLSearchParams({ id: att.id, name, mime, size: String(att.sizeBytes ?? 1000), url });
    await newTab();
    await cdp("Page.navigate", { url: `http://localhost:${process.env.HARNESS_PORT}/#${q}` });
    await until(`!!document.querySelector('[role=dialog]')`, 20_000);
  };
  // A failing browser check says what the page actually showed, so a miss is diagnosable.
  const checkB = async (name, ok, detail = "") => {
    if (ok) return check(name, true);
    const page = await evalJs("document.body ? document.body.innerText.slice(0, 200) : '(no body)'").catch(() => "(page unreachable)");
    check(name, false, `${detail}${detail ? " — " : ""}page shows: ${JSON.stringify(page)}`);
  };
  const shot = async (file) => { const r = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(`${WORK}/${file}`, Buffer.from(r.result.data, "base64")); };

  // a. Word → PDF in a blob iframe
  await open(atts.docx, "application/zip", "Fixture.docx");
  await checkB("docx: a blob: <iframe> appears", await until(`(document.querySelector('iframe')?.src ?? '').startsWith('blob:')`));
  await checkB("docx: the frame's bytes are a real PDF", await evalJs(`fetch(document.querySelector('iframe').src).then(r=>r.blob()).then(async b => b.type === 'application/pdf' && (await b.slice(0,5).text()) === '%PDF-')`));
  await checkB("docx: the frame is not sandboxed (the browser's PDF viewer needs that)", (await evalJs(`document.querySelector('iframe').hasAttribute('sandbox')`)) === false);
  await shot("viewer-docx.png");

  // b. Excel → grid
  await open(atts.xlsx, "application/zip", "Fixture.xlsx");
  await checkB("xlsx: sheet tabs in workbook order", await until(`[...document.querySelectorAll('[role=tab]')].map(t=>t.textContent).join('|') === 'Zulu|Beta ünï|Hidden'`));
  await checkB("xlsx: cell text and the limitation notice are on screen", await evalJs(`document.body.innerText.includes('FIXTURE-SHEET-MARKER') && document.body.innerText.includes("Simple data view. Formatting, merged cells, charts and images aren't shown")`));
  await evalJs(`document.querySelectorAll('[role=tab]')[1].click()`);
  await checkB("xlsx: switching tabs shows the second sheet", await until(`document.body.innerText.includes('second sheet, with comma')`));
  await shot("viewer-xlsx.png");

  // c. CSV read directly from the signed URL (CORS fetch of /media/{id})
  const csv = await upload("ada", "data.csv", Buffer.from('name;qty\n"<img src=x onerror=window.__xss=1>";4\nbolt;5\n'));
  await open(csv, "text/plain", "data.csv");
  await checkB("csv: shown as a grid", await until(`document.body.innerText.includes('bolt')`));
  await checkB("csv: markup in a cell is text — no <img>, no script ran", (await evalJs(`document.querySelector('img') === null && window.__xss === undefined && document.body.innerText.includes('<img src=x onerror=window.__xss=1>')`)) === true);
  await shot("viewer-csv.png");

  // d. A .txt. The server stores ANY .txt as text/plain (Sniff falls back to the extension), even UTF-16
  //    with NULs, so a real one takes the existing Lightbox text preview. The new text view is the safety
  //    net for an envelope that CLAIMS another mime (envelopes are sender-controlled): a .txt always opens.
  const txt = Buffer.from("héllo wörld\nsecond line", "utf16le"); // BOM-less UTF-16
  const t = await upload("ada", "notes.txt", txt);
  await checkB(`txt: the server stores any .txt as '${t.mime}' (text/plain)`, t.mime === "text/plain");
  await open(t, "application/octet-stream", "notes.txt"); // the envelope's claim
  await checkB("txt: the text view decodes BOM-less UTF-16 in a <pre>", await until(`document.querySelector('pre')?.textContent === 'héllo wörld\\nsecond line'`));

  // e. a document that cannot be previewed → the failure panel with Download
  const bad = await upload("ada", "setup.docx", Buffer.concat([Buffer.from("MZ\x90\x00"), Buffer.alloc(4096)]));
  await open(bad, "application/octet-stream", "setup.docx");
  await checkB("failure: the panel says so", await until(`document.body.innerText.includes("This document can't be previewed.")`));
  await evalJs(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Download').click()`);
  await checkB("failure: its Download button calls the surface's own download", JSON.stringify(await evalJs(`window.__downloads`)) === '["setup.docx"]');
  await shot("viewer-failure.png");

  // f. converting state, then the result, with real 202 polling over CORS
  const slow = await upload("ada", "Slow.xlsx", distinct(big("sheet64k_wide.xlsx"), "browser"));
  const tOpen = Date.now();
  await open(slow, "application/zip", "Slow.xlsx");
  await checkB("slow: shows the converting message while the server answers 202", await until(`document.body.innerText.includes('Preparing a preview')`, 30_000));
  await shot("viewer-converting.png");
  const gridShown = await until(`document.querySelector('table') !== null`, 120_000);
  await checkB(`slow: the grid appears when it is ready (${((Date.now() - tOpen) / 1000).toFixed(0)} s after opening)`, gridShown);
  await checkB("slow: it says the first rows of the total are shown", await evalJs(`/Showing the first \\d+ rows of \\d+/.test(document.body.innerText) || document.body.innerText.includes('Show more rows')`));

  await checkB("no uncaught exception in the page", consoleErrors.length === 0, consoleErrors.join("; "));
  cleanupChrome();
}

console.log(`\npassed=${pass} failed=${fail}`);
process.exit(fail ? 1 : 0);
