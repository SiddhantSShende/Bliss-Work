/**
 * Runs the REAL build.mjs for both targets and inspects the actual output —
 * not a test of build.mjs's source code, a test that the bundling pipeline
 * itself produces what this feature's requirements claim: one shared bundle,
 * a per-target manifest, and a build-time-injected browser identity with no
 * runtime branching. This is the difference between "the code compiles" and
 * "the artifact is correct", which the parent task's requirements are
 * explicit about not conflating.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = __dirname;
const CHROMIUM_OUT = join(root, "dist");
const FIREFOX_OUT = join(root, "dist-firefox");
const SAFARI_OUT = join(root, "dist-safari");

function runBuild(target: string, ...extraArgs: string[]): void {
  execFileSync("node", [join(root, "build.mjs"), `--target=${target}`, ...extraArgs], {
    cwd: root, stdio: "pipe",
  });
}

describe("build.mjs", () => {
  afterAll(() => {
    // Leaves no build artefacts behind for a test run — dist/, dist-firefox/
    // and dist-safari/ are build OUTPUT, not something a test suite should
    // change the presence of as a side effect of merely running.
    rmSync(CHROMIUM_OUT, { recursive: true, force: true });
    rmSync(FIREFOX_OUT, { recursive: true, force: true });
    rmSync(SAFARI_OUT, { recursive: true, force: true });
  });

  it("builds the chromium target with the chrome browser constant and managed-storage schema", () => {
    runBuild("chromium");
    expect(existsSync(join(CHROMIUM_OUT, "background.js"))).toBe(true);
    expect(existsSync(join(CHROMIUM_OUT, "manifest.json"))).toBe(true);
    expect(existsSync(join(CHROMIUM_OUT, "managed-schema.json"))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(CHROMIUM_OUT, "manifest.json"), "utf8"));
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.background.scripts).toBeUndefined();
    expect(manifest.browser_specific_settings).toBeUndefined();
    expect(manifest.storage?.managed_schema).toBe("managed-schema.json");

    const bundle = readFileSync(join(CHROMIUM_OUT, "background.js"), "utf8");
    expect(bundle).toContain('"chrome"');
    expect(bundle).not.toContain("__BROWSER__"); // the define must have replaced it, not left it as a global read
  });

  it("builds the firefox target with the firefox browser constant, background.scripts, and gecko settings — no managed-storage schema", () => {
    runBuild("firefox");
    expect(existsSync(join(FIREFOX_OUT, "background.js"))).toBe(true);
    expect(existsSync(join(FIREFOX_OUT, "manifest.json"))).toBe(true);
    // Firefox's managed-storage mechanism is not managed_schema — shipping
    // this file would claim a capability the Firefox manifest never declares.
    expect(existsSync(join(FIREFOX_OUT, "managed-schema.json"))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(FIREFOX_OUT, "manifest.json"), "utf8"));
    expect(manifest.background.scripts).toEqual(["background.js"]);
    expect(manifest.background.service_worker).toBeUndefined();
    expect(manifest.browser_specific_settings.gecko.id).toBeTruthy();
    expect(manifest.browser_specific_settings.gecko.strict_min_version).toBe("115.0");
    expect(manifest.storage).toBeUndefined();

    const bundle = readFileSync(join(FIREFOX_OUT, "background.js"), "utf8");
    expect(bundle).toContain('"firefox"');
  });

  it("produces the SAME source logic in both bundles — only the browser-identity literal differs", () => {
    runBuild("chromium");
    const chromiumBundle = readFileSync(join(CHROMIUM_OUT, "background.js"), "utf8");
    runBuild("firefox");
    const firefoxBundle = readFileSync(join(FIREFOX_OUT, "background.js"), "utf8");

    // Both bundles legitimately contain the literal substring "chrome" for
    // reasons that have NOTHING to do with the browser-identity constant —
    // the `chrome:` ignored-URL-scheme entry in tracker.ts's IGNORED_SCHEMES,
    // and every `chrome.*` API call itself, which Firefox natively exposes
    // too (confirmed: Firefox supports the chrome.* namespace, not only
    // browser.*, per docs/BROWSERS.md). A blanket string replace would
    // corrupt both of those and produce a false mismatch. What actually
    // differs between builds is exactly ONE embedded literal — the value
    // assigned to the minified variable holding __BROWSER__'s replacement —
    // so that is what this test isolates and compares, rather than
    // approximating "the rest is the same" with a lossy global replace.
    const browserLiteral = /var (\w)="(chrome|firefox)"/;
    const chromiumMatch = chromiumBundle.match(browserLiteral);
    const firefoxMatch = firefoxBundle.match(browserLiteral);
    expect(chromiumMatch?.[2]).toBe("chrome");
    expect(firefoxMatch?.[2]).toBe("firefox");

    // With that one literal masked out (by its exact matched text, not a
    // broad substring), the two bundles must be byte-identical — proving the
    // rest of the pipeline (tracker.ts, siteEnrichment.ts, every chrome.*
    // call in background.ts) really is the same code, unbundled twice.
    const stripLiteral = (src: string, match: RegExpMatchArray | null) =>
      match ? src.replace(match[0], "var X=MASKED") : src;
    expect(stripLiteral(chromiumBundle, chromiumMatch)).toBe(
      stripLiteral(firefoxBundle, firefoxMatch),
    );
  });

  it("rejects an unknown --target rather than silently building something", () => {
    expect(() => runBuild("internet-explorer")).toThrow();
  });

  it("builds firefox normally (no --strict) even with the placeholder gecko id", () => {
    // The everyday case: loading unpacked in about:debugging, which does not
    // care what the id is. Only an explicit --strict build (a real AMO
    // submission) needs to reject the placeholder — see the next test.
    expect(() => runBuild("firefox")).not.toThrow();
  });

  it("--strict rejects the placeholder gecko id rather than shipping it to AMO", () => {
    expect(() => runBuild("firefox", "--strict")).toThrow();
  });

  it("builds the safari target with the safari browser constant and service_worker — no managed-storage schema, no gecko block", () => {
    runBuild("safari");
    expect(existsSync(join(SAFARI_OUT, "background.js"))).toBe(true);
    expect(existsSync(join(SAFARI_OUT, "manifest.json"))).toBe(true);
    // Same reasoning as Firefox: shipping this file would claim a capability
    // (Chrome's storage.managed_schema mechanism) the Safari manifest never
    // declares and Safari's own managed-config story does not use.
    expect(existsSync(join(SAFARI_OUT, "managed-schema.json"))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(SAFARI_OUT, "manifest.json"), "utf8"));
    // Safari's WebExtension implementation supports service_worker (unlike
    // Firefox, which needs the background.scripts array form) — so the Safari
    // manifest is structurally closer to Chromium's than to Firefox's.
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.background.scripts).toBeUndefined();
    expect(manifest.browser_specific_settings).toBeUndefined();
    expect(manifest.storage).toBeUndefined();

    const bundle = readFileSync(join(SAFARI_OUT, "background.js"), "utf8");
    expect(bundle).toContain('"safari"');
    expect(bundle).not.toContain("__BROWSER__");
  });
});
