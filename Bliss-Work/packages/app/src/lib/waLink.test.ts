import { describe, expect, it } from "vitest";

import { encodeLocation } from "./chatEnvelope";
import { WA_URL_MAX, waForwardText, waShareLink } from "./waLink";

describe("waForwardText", () => {
  it("passes plain text through", () => {
    expect(waForwardText("ship it")).toBe("ship it");
  });

  it("strips the envelope sentinel and JSON from a structured body", () => {
    // Without this, a shared location would dump raw JSON into WhatsApp.
    const body = encodeLocation({ lat: 51.5074, lng: -0.1278, label: "Office" });
    const out = waForwardText(body);
    expect(out).not.toContain("");
    expect(out).not.toContain('"kind"');
    expect(out).toContain("Office");
  });

  it("appends a maps link for a location, so the recipient gets something usable", () => {
    const body = encodeLocation({ lat: 51.5074, lng: -0.1278 });
    expect(waForwardText(body)).toMatch(/https:\/\/(www\.google\.com\/maps|maps\.apple\.com)/);
  });
});

describe("waShareLink", () => {
  it("omits the recipient entirely, so WhatsApp asks who to send to", () => {
    const url = waShareLink("Ship it on Friday");
    // No path segment between wa.me/ and the query — that absence IS the
    // feature: it makes WhatsApp open its own contact chooser.
    expect(url).toBe("https://wa.me/?text=Ship%20it%20on%20Friday");
    expect(url).not.toMatch(/wa\.me\/\d/);
  });

  it("encodes text that would otherwise break the query string", () => {
    expect(waShareLink("a&b=c?d #e")).toBe("https://wa.me/?text=a%26b%3Dc%3Fd%20%23e");
  });

  it("stays within WA_URL_MAX for a long body", () => {
    const url = waShareLink("x".repeat(5000));
    expect(url.length).toBeLessThanOrEqual(WA_URL_MAX);
    expect(url.endsWith("%E2%80%A6")).toBe(true); // the ellipsis
  });

  it("stays within WA_URL_MAX for emoji, and never splits one", () => {
    const url = waShareLink("🙂".repeat(2000));
    expect(url.length).toBeLessThanOrEqual(WA_URL_MAX);
    // A half-cut surrogate pair would decode to U+FFFD.
    expect(decodeURIComponent(url.slice(url.indexOf("?text=") + 6))).not.toContain("�");
  });

  it("never truncates through a surrogate pair", () => {
    // A byte- or UTF-16-unit-based cut would leave a lone surrogate, which
    // encodeURIComponent throws on and which renders as U+FFFD if it survives.
    // Swept across lengths because only some land the cut mid-pair.
    for (let n = 150; n < 400; n += 7) {
      const url = waShareLink("👩‍💻".repeat(n));
      expect(url.length).toBeLessThanOrEqual(WA_URL_MAX);
      const text = url.slice(url.indexOf("?text=") + 6);
      expect(() => decodeURIComponent(text)).not.toThrow();
      expect(decodeURIComponent(text)).not.toContain("�");
    }
  });

  it("carries a structured body's readable text, not its envelope JSON", () => {
    const body = encodeLocation({ lat: 51.5074, lng: -0.1278, label: "Office" });
    const url = waShareLink(waForwardText(body));
    const decoded = decodeURIComponent(url.slice(url.indexOf("?text=") + 6));
    expect(decoded).toContain("📍 Office");
    expect(decoded).not.toContain('{"v"');
    // A location forwards as something the recipient can actually open.
    expect(decoded).toContain("https://");
  });
});
