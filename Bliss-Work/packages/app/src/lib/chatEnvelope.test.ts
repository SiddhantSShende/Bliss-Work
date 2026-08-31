import { describe, expect, it } from "vitest";
import {
  MEDIA_MAX_FILES,
  attachmentIdsOf,
  encodeLocation,
  encodeMedia,
  isMediaMessage,
  listPreview,
  parseChatEnvelope,
  readablePrefix,
  type MediaItem,
} from "./chatEnvelope";
import { encodeFileOffer } from "./fileOffer";

// U+001F literal, spelled out: a raw control character in source is easy to
// lose to an editor or formatter, and losing it turns these assertions into
// silent no-ops (toContain("") is always true).
const SEP = String.fromCharCode(0x1f);

const img = (over: Partial<MediaItem> = {}): MediaItem => ({
  id: "018f0000-0000-7000-8000-000000000001",
  name: "photo.jpg",
  size: 2_100_000,
  mime: "image/jpeg",
  ...over,
});

describe("media envelopes", () => {
  it("round-trips", () => {
    const items = [img(), img({ id: "b", name: "clip.mp4", mime: "video/mp4", durationMs: 4200 })];
    const env = parseChatEnvelope(encodeMedia(items));
    expect(env).toMatchObject({ v: 2, kind: "media" });
    expect(env && env.kind === "media" && env.items).toHaveLength(2);
    expect(env && env.kind === "media" && env.items[1]?.durationMs).toBe(4200);
  });

  it("puts a standalone readable prefix before the payload", () => {
    // Anything that cannot parse the envelope — inbox rows, push notifications,
    // the server's own truncatePreview — shows only this prefix.
    const body = encodeMedia([img()]);
    const prefix = body.slice(0, body.indexOf(SEP));
    expect(prefix).toBe("🖼️ photo.jpg · 2.0 MB");
    expect(prefix).not.toContain("{");
  });

  it("summarises multiple files", () => {
    const photos = encodeMedia([img(), img({ id: "b" }), img({ id: "c" })]);
    expect(photos.split(SEP)[0]).toBe("🖼️ 3 photos");

    const mixed = encodeMedia([img(), img({ id: "b", name: "a.pdf", mime: "application/pdf" })]);
    expect(mixed.split(SEP)[0]).toMatch(/^📎 2 files · /);
  });

  it("collects attachment ids including thumbnails", () => {
    const env = parseChatEnvelope(encodeMedia([img({ thumbId: "thumb-1" })]));
    expect(attachmentIdsOf(env)).toEqual(["018f0000-0000-7000-8000-000000000001", "thumb-1"]);
  });

  it("caps the number of items it will parse", () => {
    const many = Array.from({ length: 50 }, (_, i) => img({ id: `id-${i}` }));
    const env = parseChatEnvelope(encodeMedia(many));
    expect(env && env.kind === "media" && env.items.length).toBe(MEDIA_MAX_FILES);
  });

  it("stays far below the 1 MiB message body cap at max items", () => {
    const items = Array.from({ length: MEDIA_MAX_FILES }, (_, i) =>
      img({ id: `018f0000-0000-7000-8000-00000000000${i}`, name: "x".repeat(255) }),
    );
    expect(new Blob([encodeMedia(items)]).size).toBeLessThan(64 * 1024);
  });
});

describe("location envelopes", () => {
  it("round-trips", () => {
    const env = parseChatEnvelope(encodeLocation({ lat: 12.9716, lng: 77.5946, label: "Office" }));
    expect(env).toMatchObject({ v: 2, kind: "location", lat: 12.9716, lng: 77.5946, label: "Office" });
  });

  it("labels the prefix, falling back to a generic one", () => {
    expect(encodeLocation({ lat: 1, lng: 2, label: "Office" }).split(SEP)[0]).toBe("📍 Office");
    expect(encodeLocation({ lat: 1, lng: 2 }).split(SEP)[0]).toBe("📍 Shared location");
  });

  it("rejects out-of-range coordinates rather than rendering them", () => {
    for (const bad of [
      { lat: 91, lng: 0 },
      { lat: -91, lng: 0 },
      { lat: 0, lng: 181 },
      { lat: 0, lng: -181 },
    ]) {
      expect(parseChatEnvelope(encodeLocation(bad))).toBeNull();
    }
  });

  it("rejects non-finite coordinates", () => {
    const body = `📍 x${SEP}${JSON.stringify({ v: 2, kind: "location", lat: null, lng: 1 })}`;
    expect(parseChatEnvelope(body)).toBeNull();
  });
});

describe("backward compatibility", () => {
  it("still parses v1 peer-to-peer file offers", () => {
    const body = encodeFileOffer({
      offerId: "offer-1",
      name: "big.zip",
      size: 12_000_000_000,
      sha256: "deadbeef",
      mime: "application/zip",
    });
    const env = parseChatEnvelope(body);
    expect(env).toMatchObject({ v: 1, kind: "fileOffer" });
    expect(env && env.kind === "fileOffer" && env.offer.name).toBe("big.zip");
  });
});

describe("hostile and malformed bodies", () => {
  // The body is chosen by the sender, and a forwarded message carries a body
  // written by someone the viewer may not trust. Bad input must degrade to
  // plain text, never throw and blank the thread.
  it("treats plain text as plain text", () => {
    expect(parseChatEnvelope("just a message")).toBeNull();
    expect(parseChatEnvelope("")).toBeNull();
  });

  it("treats a sentinel followed by garbage as plain text", () => {
    for (const body of [
      `hello${SEP}not json`,
      `hello${SEP}{`,
      `hello${SEP}null`,
      `hello${SEP}[]`,
      `hello${SEP}"a string"`,
      `hello${SEP}123`,
    ]) {
      expect(() => parseChatEnvelope(body)).not.toThrow();
      expect(parseChatEnvelope(body)).toBeNull();
    }
  });

  it("drops items missing an id instead of rendering a broken bubble", () => {
    const body = `x${SEP}${JSON.stringify({
      v: 2,
      kind: "media",
      items: [{ name: "no-id.jpg" }, { id: "ok", name: "fine.jpg", mime: "image/jpeg", size: 1 }],
    })}`;
    const env = parseChatEnvelope(body);
    expect(env && env.kind === "media" && env.items.map((i) => i.id)).toEqual(["ok"]);
  });

  it("returns null when no item survives validation", () => {
    const body = `x${SEP}${JSON.stringify({ v: 2, kind: "media", items: [{}, 7, null] })}`;
    expect(parseChatEnvelope(body)).toBeNull();
  });

  it("defaults a missing mime to a type that is never rendered inline", () => {
    const body = `x${SEP}${JSON.stringify({ v: 2, kind: "media", items: [{ id: "a" }] })}`;
    const env = parseChatEnvelope(body);
    expect(env && env.kind === "media" && env.items[0]?.mime).toBe("application/octet-stream");
  });

  it("ignores unknown versions and kinds", () => {
    for (const payload of [
      { v: 3, kind: "media", items: [{ id: "a" }] },
      { v: 2, kind: "wat", items: [{ id: "a" }] },
      { v: 2 },
    ]) {
      expect(parseChatEnvelope(`x${SEP}${JSON.stringify(payload)}`)).toBeNull();
    }
  });
});

describe("readablePrefix", () => {
  // The desktop pinned-chat window renders message text with connect-src 'none',
  // so it can never load an attachment. It must show the summary, never the raw
  // envelope JSON.
  it("strips the envelope from structured bodies", () => {
    expect(readablePrefix(encodeMedia([img()]))).toBe("🖼️ photo.jpg · 2.0 MB");
    expect(readablePrefix(encodeLocation({ lat: 1, lng: 2, label: "Office" }))).toBe("📍 Office");
    expect(
      readablePrefix(
        encodeFileOffer({ offerId: "o", name: "a.zip", size: 10, sha256: "d", mime: "application/zip" }),
      ),
    ).toBe("📎 a.zip · 10 B");
  });

  it("never leaks JSON or the sentinel", () => {
    for (const body of [
      encodeMedia([img(), img({ id: "b" })]),
      encodeLocation({ lat: 1, lng: 2 }),
      `x${SEP}${JSON.stringify({ v: 2, kind: "media", items: [] })}`,
    ]) {
      const out = readablePrefix(body);
      expect(out).not.toContain(SEP);
      expect(out).not.toContain('"v":');
      expect(out).not.toContain("{");
    }
  });

  it("passes plain text through unchanged", () => {
    expect(readablePrefix("just a message")).toBe("just a message");
    expect(readablePrefix("")).toBe("");
  });
});

describe("listPreview", () => {
  it("shows Link sent when the whole body is one URL", () => {
    expect(listPreview("https://example.com/roadmap")).toBe("Link sent");
    expect(listPreview("  https://example.com/roadmap  ")).toBe("Link sent");
  });

  it("shows Link sent when a link is embedded in a longer message", () => {
    expect(listPreview("check this out: https://example.com/roadmap")).toBe("Link sent");
  });

  it("is direction-aware for an embedded link, like a bare one", () => {
    expect(listPreview("check this out: https://example.com/roadmap", false)).toBe(
      "Link received",
    );
  });

  it("leaves plain text and structured previews unchanged", () => {
    expect(listPreview("just a message")).toBe("just a message");
    expect(listPreview(encodeMedia([img()]))).toBe("Image sent");
  });
});

describe("isMediaMessage", () => {
  // Drives whether the Forward affordance is shown: forwarding clones the body
  // verbatim, handing attachment ids to someone outside their scope.
  it("is true only for media", () => {
    expect(isMediaMessage(encodeMedia([img()]))).toBe(true);
    expect(isMediaMessage(encodeLocation({ lat: 1, lng: 2 }))).toBe(false);
    expect(isMediaMessage("plain text")).toBe(false);
  });
});
