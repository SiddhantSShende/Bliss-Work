/**
 * The chat transcript.
 *
 * Two rules matter here. The file must never contain an envelope — a reader
 * opening a transcript should see "🖼️ roadmap.png · 2.0 KB" where a photo was,
 * not the JSON the body actually holds. And the header must say how many
 * messages are in the file, because the export covers the history that was
 * LOADED and a transcript that implies otherwise is a lie in a document people
 * keep.
 *
 * Timestamps are hand-formatted rather than localised, so this file reads the
 * same on a colleague's machine as it does on yours — asserted here because a
 * `toLocaleString` would pass a test run in one locale and fail in another.
 */
import { describe, it, expect, vi } from "vitest";
import { encodeMedia } from "./chatEnvelope";

const downloadBlob = vi.fn();
vi.mock("./download", () => ({ downloadBlob: (b: Blob, n: string) => downloadBlob(b, n) }));

import { buildTranscript, exportChatTranscript, transcriptFilename } from "./chatExport";

const ME = "018f0000-0000-7000-8000-0000000000a1";
const PEER = "018f0000-0000-7000-8000-0000000000a2";
// Local time, so the assertions below hold whatever TZ the runner is in.
const NOW = new Date(2026, 7, 20, 14, 5);
const AT = new Date(2026, 7, 19, 9, 12).toISOString();

const options = { title: "#general", meId: ME, now: NOW };

describe("buildTranscript", () => {
  it("heads the file with what it is, what it covers and how much of it there is", () => {
    const text = buildTranscript(
      [{ body: "Morning", at: AT, senderId: PEER, senderName: "Ada Lovelace" }],
      options,
    );
    expect(text.split("\n").slice(0, 3)).toEqual([
      "BlissWork conversation transcript",
      "#general",
      "Exported 2026-08-20 14:05 · 1 message loaded",
    ]);
  });

  it("counts in the plural for anything but one", () => {
    expect(buildTranscript([], options)).toContain("0 messages loaded");
  });

  it("names the reader's own lines the way the thread does", () => {
    const text = buildTranscript(
      [
        { body: "Morning", at: AT, senderId: PEER, senderName: "Ada Lovelace" },
        { body: "Hello", at: AT, senderId: ME, senderName: "Ada Lovelace" },
      ],
      options,
    );
    expect(text).toContain("[2026-08-19 09:12] Ada Lovelace: Morning");
    expect(text).toContain("[2026-08-19 09:12] You: Hello");
  });

  it("writes an attachment as its readable summary, never as its envelope", () => {
    const body = encodeMedia([
      { id: "a1", name: "roadmap.png", size: 2048, mime: "image/png" },
    ]);
    const text = buildTranscript([{ body, at: AT, senderId: PEER, senderName: "Ada" }], options);
    expect(text).toContain("roadmap.png");
    expect(text).not.toContain('"kind":"media"');
    expect(text).not.toContain("a1");
  });

  it("says a message was deleted rather than printing an empty line", () => {
    const text = buildTranscript(
      [{ body: "", at: AT, senderId: PEER, senderName: "Ada", deletedForAll: true }],
      options,
    );
    expect(text).toContain("Ada: (deleted)");
  });

  it("marks a message that has not landed yet rather than inventing a time", () => {
    const text = buildTranscript([{ body: "Sending…", senderId: ME }], options);
    expect(text).toContain("[—] You: Sending…");
  });
});

describe("transcriptFilename", () => {
  it("slugs the conversation and dates the file", () => {
    expect(transcriptFilename("#general", NOW)).toBe("blisswork-general-2026-08-20.txt");
    expect(transcriptFilename("Ada Lovelace", NOW)).toBe("blisswork-ada-lovelace-2026-08-20.txt");
  });

  it("still names a file for a conversation with no usable title", () => {
    expect(transcriptFilename("🙂", NOW)).toBe("blisswork-chat-2026-08-20.txt");
  });
});

describe("exportChatTranscript", () => {
  it("hands the browser a text file under that name", () => {
    downloadBlob.mockClear();
    exportChatTranscript([{ body: "Morning", at: AT, senderId: ME }], options);
    expect(downloadBlob).toHaveBeenCalledOnce();
    const [blob, name] = downloadBlob.mock.calls[0]!;
    expect(name).toBe("blisswork-general-2026-08-20.txt");
    expect((blob as Blob).type).toBe("text/plain;charset=utf-8");
  });
});
