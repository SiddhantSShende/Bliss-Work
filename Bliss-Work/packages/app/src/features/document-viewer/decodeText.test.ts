import { describe, expect, it } from "vitest";
import { decodeText, detectEncoding } from "./decodeText";

const utf16le = (s: string, bom = true) => {
  const out = new Uint8Array((s.length + (bom ? 1 : 0)) * 2);
  let o = 0;
  if (bom) {
    out[o++] = 0xff;
    out[o++] = 0xfe;
  }
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out[o++] = c & 0xff;
    out[o++] = c >> 8;
  }
  return out;
};
const utf16be = (s: string, bom = true) => {
  const le = utf16le(s, bom);
  for (let i = 0; i + 1 < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1]!, le[i]!];
  return le;
};

describe("decodeText", () => {
  it("decodes UTF-8, with and without a BOM", () => {
    const enc = new TextEncoder().encode("héllo, wörld ✓");
    expect(decodeText(enc).text).toBe("héllo, wörld ✓");
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc]);
    expect(decodeText(withBom)).toEqual({ text: "héllo, wörld ✓", encoding: "utf-8" });
  });

  it("decodes UTF-16 LE and BE with a BOM", () => {
    expect(decodeText(utf16le("Grüße, 世界"))).toEqual({ text: "Grüße, 世界", encoding: "utf-16le" });
    expect(decodeText(utf16be("Grüße, 世界"))).toEqual({ text: "Grüße, 世界", encoding: "utf-16be" });
  });

  it("recognises BOM-less UTF-16 of mostly-ASCII text", () => {
    expect(detectEncoding(utf16le("plain ascii text here", false)).encoding).toBe("utf-16le");
    expect(detectEncoding(utf16be("plain ascii text here", false)).encoding).toBe("utf-16be");
    expect(decodeText(utf16le("plain ascii text here", false)).text).toBe("plain ascii text here");
  });

  it("does not mistake ordinary UTF-8 for UTF-16", () => {
    expect(detectEncoding(new TextEncoder().encode("just some ordinary text, nothing odd")).encoding).toBe("utf-8");
    expect(detectEncoding(new Uint8Array(0)).encoding).toBe("utf-8");
    expect(detectEncoding(new Uint8Array([65, 66])).encoding).toBe("utf-8");
  });

  it("replaces invalid bytes instead of throwing", () => {
    expect(decodeText(new Uint8Array([0x61, 0xff, 0xfe - 1, 0x62])).text).toContain("a");
    expect(() => decodeText(new Uint8Array([0xc3, 0x28, 0xa0, 0xa1]))).not.toThrow();
  });
});
