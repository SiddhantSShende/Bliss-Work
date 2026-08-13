import { describe, expect, it } from "vitest";

import { encodeLocation } from "./chatEnvelope";
import { WA_URL_MAX, formatE164, normalizeE164, waForwardText, waLink } from "./waLink";

describe("normalizeE164", () => {
  // These vectors are deliberately mirrored in
  // services/messaging-svc/internal/api/phone_test.go. The Go implementation is
  // authoritative — this one exists so the UI can disable a submit button — and
  // the shared table is what stops the two drifting apart unnoticed.
  it.each([
    ["the spec's own example", "+1 (555) 019-2834", "15550192834"],
    ["already normalized", "15550192834", "15550192834"],
    ["00 international prefix", "0044 20 7946 0958", "442079460958"],
    ["plus international prefix", "+44 20 7946 0958", "442079460958"],
    ["single leading zero", "015550192834", "15550192834"],
    ["dots and dashes", "1.555.019.2834", "15550192834"],
    ["maximum length", "9".repeat(15), "9".repeat(15)],
    ["minimum length", "9".repeat(8), "9".repeat(8)],
  ])("accepts %s", (_name, input, want) => {
    expect(normalizeE164(input)).toBe(want);
  });

  it.each([
    ["empty", ""],
    ["letters only", "call me"],
    ["punctuation only", "+()- "],
    ["too short", "1234567"],
    ["too long", "9".repeat(16)],
    ["all zeroes reduces to nothing", "0000000000"],
    ["local number without country code", "0192834"],
  ])("rejects %s", (_name, input) => {
    expect(normalizeE164(input)).toBeNull();
  });
});

describe("formatE164", () => {
  it("prefixes '+' without inventing a grouping we cannot know", () => {
    expect(formatE164("15550192834")).toBe("+15550192834");
    expect(formatE164("442079460958")).toBe("+442079460958");
  });
});

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

describe("waLink", () => {
  it("encodes the text into the query string", () => {
    expect(waLink("15550192834", "hi there & co")).toBe(
      "https://wa.me/15550192834?text=hi%20there%20%26%20co",
    );
  });

  it("stays within WA_URL_MAX for a long ASCII body", () => {
    // The desktop app silently refuses URLs over 2048 chars — the button would
    // do nothing at all, with no error surfaced to the user.
    const url = waLink("15550192834", "a".repeat(5000));
    expect(url.length).toBeLessThanOrEqual(WA_URL_MAX);
    expect(url.endsWith("%E2%80%A6")).toBe(true); // the ellipsis marker
  });

  it("stays within WA_URL_MAX for emoji, which encode to 12+ chars each", () => {
    const url = waLink("15550192834", "🖼".repeat(2000));
    expect(url.length).toBeLessThanOrEqual(WA_URL_MAX);
  });

  it("never truncates through a surrogate pair", () => {
    // A byte- or UTF-16-unit-based cut would leave a lone surrogate, which
    // encodeURIComponent throws on and which renders as U+FFFD if it survives.
    for (let n = 150; n < 400; n += 7) {
      const url = waLink("15550192834", "👩‍💻".repeat(n));
      expect(url.length).toBeLessThanOrEqual(WA_URL_MAX);
      expect(() => decodeURIComponent(url.slice(url.indexOf("?text=") + 6))).not.toThrow();
      expect(decodeURIComponent(url.slice(url.indexOf("?text=") + 6))).not.toContain("�");
    }
  });
});
