/**
 * Pulling the media, documents and links back out of a loaded thread.
 *
 * Three rules are worth pinning. Attachments split by the SERVER-sniffed mime,
 * not by filename, because that is the value the rest of the app renders from.
 * Links are absolute http(s) only — turning a bare "acme.com" into something
 * clickable is a decision the sender did not make. And the panel reads
 * newest-first, which is the opposite of the thread's own order.
 */
import { describe, it, expect } from "vitest";
import { collectChatAssets } from "./chatAssets";
import { encodeMedia, encodeLocation, type MediaItem } from "./chatEnvelope";

const item = (over: Partial<MediaItem> & { id: string }): MediaItem => ({
  name: "file",
  size: 1024,
  mime: "application/octet-stream",
  ...over,
});

const PHOTO = item({ id: "a1", name: "roadmap.png", mime: "image/png" });
const CLIP = item({ id: "a2", name: "demo.mp4", mime: "video/mp4", thumbId: "a2t" });
const SHEET = item({ id: "a3", name: "q3.xlsx", mime: "application/vnd.ms-excel" });

describe("collectChatAssets", () => {
  it("splits photos and video from every other kind of file", () => {
    const assets = collectChatAssets([
      { id: "m1", body: encodeMedia([PHOTO, CLIP, SHEET]), senderName: "Ada" },
    ]);
    expect(assets.media.map((a) => a.item.name)).toEqual(["roadmap.png", "demo.mp4"]);
    expect(assets.docs.map((a) => a.item.name)).toEqual(["q3.xlsx"]);
  });

  it("carries who shared it and when, so a tile can say where it came from", () => {
    const assets = collectChatAssets([
      { id: "m1", body: encodeMedia([PHOTO]), senderName: "Ada", at: "2026-08-20T09:00:00Z" },
    ]);
    expect(assets.media[0]).toMatchObject({
      messageId: "m1",
      senderName: "Ada",
      at: "2026-08-20T09:00:00Z",
    });
  });

  it("reads newest first — the opposite of the thread", () => {
    const assets = collectChatAssets([
      { id: "old", body: "first https://acme.test/one" },
      { id: "new", body: "later https://acme.test/two" },
    ]);
    expect(assets.links.map((l) => l.url)).toEqual([
      "https://acme.test/two",
      "https://acme.test/one",
    ]);
  });

  it("takes absolute http(s) URLs only", () => {
    const assets = collectChatAssets([
      { id: "m1", body: "try acme.com or www.acme.com or ftp://acme.com — but https://acme.test works" },
    ]);
    expect(assets.links.map((l) => l.url)).toEqual(["https://acme.test"]);
  });

  it("does not swallow the sentence's punctuation into the link", () => {
    const assets = collectChatAssets([
      { id: "m1", body: "see https://acme.test/docs. Also (https://acme.test/x)" },
    ]);
    // Newest MESSAGE first; within one message, reading order.
    expect(assets.links.map((l) => l.url)).toEqual([
      "https://acme.test/docs",
      "https://acme.test/x",
    ]);
  });

  it("looks for no link inside an attachment's generated summary", () => {
    // "🖼️ roadmap.png · 2.0 KB" is written by the sender's client, not typed.
    const assets = collectChatAssets([{ id: "m1", body: encodeMedia([PHOTO]) }]);
    expect(assets.links).toEqual([]);
  });

  it("ignores a message deleted for everyone", () => {
    const assets = collectChatAssets([
      { id: "m1", body: encodeMedia([PHOTO]), deletedForAll: true },
      { id: "m2", body: "https://acme.test", deletedForAll: true },
    ]);
    expect(assets).toEqual({ media: [], docs: [], links: [] });
  });

  it("has nothing to say about a shared location", () => {
    const assets = collectChatAssets([
      { id: "m1", body: encodeLocation({ lat: 51.5, lng: -0.12, label: "The office" }) },
    ]);
    expect(assets).toEqual({ media: [], docs: [], links: [] });
  });

  it("is empty for an empty thread", () => {
    expect(collectChatAssets([])).toEqual({ media: [], docs: [], links: [] });
  });
});
