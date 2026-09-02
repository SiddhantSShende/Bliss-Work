import { describe, expect, it } from "vitest";
import { truncateToUtf8Bytes, utf8ByteLength } from "./textBytes";

describe("utf8ByteLength", () => {
  it("matches .length for ASCII text", () => {
    expect(utf8ByteLength("hello")).toBe(5);
  });

  it("counts 3 bytes per character for CJK text, not the 1 code unit .length counts", () => {
    // "あ" (U+3042) is one UTF-16 code unit but three UTF-8 bytes — the exact
    // gap that let a message which reads as "under the cap" on this side come
    // back as a server error on the other.
    const s = "あ".repeat(300);
    expect(s.length).toBe(300);
    expect(utf8ByteLength(s)).toBe(900);
  });

  it("counts 4 bytes for an astral character encoded as a surrogate pair", () => {
    const emoji = "😀"; // U+1F600
    expect(emoji.length).toBe(2); // two UTF-16 code units
    expect(utf8ByteLength(emoji)).toBe(4);
  });
});

describe("truncateToUtf8Bytes", () => {
  it("is a no-op once the text already fits", () => {
    expect(truncateToUtf8Bytes("hello", 500)).toBe("hello");
  });

  it("trims ASCII text to exactly the byte cap", () => {
    const out = truncateToUtf8Bytes("x".repeat(600), 500);
    expect(out).toHaveLength(500);
    expect(utf8ByteLength(out)).toBe(500);
  });

  it("trims CJK text on a character boundary — never a partial byte sequence", () => {
    const s = "あ".repeat(300); // 900 bytes
    const out = truncateToUtf8Bytes(s, 500);
    // 500 / 3 bytes-per-character = 166 whole characters fit; the 167th would
    // push the total to 501.
    expect(out).toBe("あ".repeat(166));
    expect(utf8ByteLength(out)).toBeLessThanOrEqual(500);
  });

  it("never splits a surrogate pair in half", () => {
    const s = "😀".repeat(200); // 800 bytes
    const out = truncateToUtf8Bytes(s, 500);
    // Each emoji is 4 bytes; 500 / 4 = 125 whole characters fit exactly.
    expect(out).toBe("😀".repeat(125));
    // Array.from walks by codepoint — an unpaired surrogate would show up as
    // an extra, malformed entry here rather than a clean 125.
    expect(Array.from(out)).toHaveLength(125);
  });
});
