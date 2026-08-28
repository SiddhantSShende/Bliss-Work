import { describe, expect, it } from "vitest";
import { detectBrowserFamily, supportsAutoExtensionIntegration } from "./browserDetect";

const UA = {
  chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  safari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  nothingRecognized: "SomeOtherAgent/1.0",
};

describe("detectBrowserFamily", () => {
  it("recognises Chrome", () => {
    expect(detectBrowserFamily(UA.chrome, false)).toBe("chrome");
  });

  it("recognises Edge ahead of the Chrome token its UA also carries", () => {
    expect(detectBrowserFamily(UA.edge, false)).toBe("edge");
  });

  it("recognises Brave via navigator.brave regardless of its (Chrome-identical) UA string", () => {
    expect(detectBrowserFamily(UA.chrome, true)).toBe("brave");
  });

  it("recognises Firefox", () => {
    expect(detectBrowserFamily(UA.firefox, false)).toBe("firefox");
  });

  it("recognises Safari once Chrome/Chromium tokens are ruled out", () => {
    expect(detectBrowserFamily(UA.safari, false)).toBe("safari");
  });

  it("falls back to unknown for an unrecognised agent, rather than guessing", () => {
    expect(detectBrowserFamily(UA.nothingRecognized, false)).toBe("unknown");
  });
});

describe("supportsAutoExtensionIntegration", () => {
  it("is true only for the Chromium-family browsers the extension's manifest actually declares externally_connectable for", () => {
    expect(supportsAutoExtensionIntegration("chrome")).toBe(true);
    expect(supportsAutoExtensionIntegration("edge")).toBe(true);
    expect(supportsAutoExtensionIntegration("brave")).toBe(true);
  });

  it("is false for Firefox and Safari — their manifests declare no externally_connectable, so claiming support here would be fake", () => {
    expect(supportsAutoExtensionIntegration("firefox")).toBe(false);
    expect(supportsAutoExtensionIntegration("safari")).toBe(false);
  });

  it("is false for an unrecognised browser", () => {
    expect(supportsAutoExtensionIntegration("unknown")).toBe(false);
  });
});
