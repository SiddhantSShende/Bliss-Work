import { describe, expect, it } from "vitest";
import { isUrlOnly, linkifyMessage } from "./chatFormat";

describe("linkifyMessage", () => {
  it("turns a plain call URL into a single link segment", () => {
    const url = "https://communication.rnrtechs.com/join?t=ABC123";
    expect(linkifyMessage(url)).toEqual([{ type: "link", value: url }]);
  });

  it("keeps a call URL's query parameters intact", () => {
    const url = "https://communication.rnrtechs.com/join?t=ABC123&x=1";
    const segments = linkifyMessage(url);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ type: "link", value: url });
  });

  it("preserves the surrounding text exactly, splitting only at the URL", () => {
    const url = "https://communication.rnrtechs.com/join?t=ABC123";
    const segments = linkifyMessage(`Join my call: ${url}`);
    expect(segments).toEqual([
      { type: "text", value: "Join my call: " },
      { type: "link", value: url },
    ]);
  });

  it("linkifies a URL in the middle of a sentence, leaving both sides as text", () => {
    const url = "https://example.com/page";
    const segments = linkifyMessage(`see ${url} for details`);
    expect(segments).toEqual([
      { type: "text", value: "see " },
      { type: "link", value: url },
      { type: "text", value: " for details" },
    ]);
  });

  it("does not touch plain text with no URL at all", () => {
    expect(linkifyMessage("just a normal message")).toEqual([
      { type: "text", value: "just a normal message" },
    ]);
  });

  it("linkifies a non-BlissWork URL too — nothing is hardcoded to one domain", () => {
    const url = "https://example.org/anything?a=1";
    expect(linkifyMessage(url)).toEqual([{ type: "link", value: url }]);
  });

  it("finds multiple URLs in one message", () => {
    const a = "https://a.example.com/x";
    const b = "https://b.example.com/y";
    expect(linkifyMessage(`first ${a} then ${b} done`)).toEqual([
      { type: "text", value: "first " },
      { type: "link", value: a },
      { type: "text", value: " then " },
      { type: "link", value: b },
      { type: "text", value: " done" },
    ]);
  });

  it("drops trailing sentence punctuation from the link, keeping it in the text", () => {
    const url = "https://example.com/join?t=ABC123";
    const segments = linkifyMessage(`Join here: ${url}.`);
    expect(segments).toEqual([
      { type: "text", value: "Join here: " },
      { type: "link", value: url },
      { type: "text", value: "." },
    ]);
  });

  it("keeps a closing paren that belongs to the URL itself", () => {
    const url = "https://en.wikipedia.org/wiki/Foo_(bar)";
    expect(linkifyMessage(`See ${url}`)).toEqual([
      { type: "text", value: "See " },
      { type: "link", value: url },
    ]);
  });

  it("strips a closing paren that wraps the URL rather than belonging to it", () => {
    const url = "https://example.com/join";
    const segments = linkifyMessage(`(join here: ${url})`);
    expect(segments).toEqual([
      { type: "text", value: "(join here: " },
      { type: "link", value: url },
      { type: "text", value: ")" },
    ]);
  });

  it("never linkifies a non-http(s) scheme, so nothing but a URL is ever made clickable", () => {
    expect(linkifyMessage("run javascript:alert(1) now")).toEqual([
      { type: "text", value: "run javascript:alert(1) now" },
    ]);
    expect(linkifyMessage("see mailto:a@b.com")).toEqual([
      { type: "text", value: "see mailto:a@b.com" },
    ]);
  });

  it("a matched URL never contains an angle bracket or quote — the injection surface an <a href> would care about", () => {
    const segments = linkifyMessage('go to https://example.com/x"><script>alert(1)</script> now');
    const link = segments.find((s) => s.type === "link");
    expect(link?.value).toBe("https://example.com/x");
    expect(link?.value).not.toMatch(/["<>]/);
    // The script text is preserved as ordinary text, not markup — the caller
    // renders every segment as a text child, so this never executes.
    expect(segments.some((s) => s.type === "text" && s.value.includes("<script>"))).toBe(true);
  });

  it("round-trips: concatenating every segment's value reproduces the original body", () => {
    const body = 'Join my call: https://x.example.com/join?t=ABC123 — see you there!';
    const segments = linkifyMessage(body);
    expect(segments.map((s) => s.value).join("")).toBe(body);
  });
});

describe("isUrlOnly", () => {
  it("is true for a bare URL and nothing else", () => {
    expect(isUrlOnly("https://example.com")).toBe(true);
  });

  it("is true for a bare URL with a path and query string", () => {
    expect(isUrlOnly("https://example.com/join?t=ABC123&x=1")).toBe(true);
  });

  it("is false for a URL with surrounding words", () => {
    expect(isUrlOnly("see https://example.com for details")).toBe(false);
  });

  it("is false for two URLs, even with nothing else", () => {
    expect(isUrlOnly("https://a.example.com https://b.example.com")).toBe(false);
  });

  it("is false for plain text with no URL at all", () => {
    expect(isUrlOnly("just a normal message")).toBe(false);
  });

  it("is false for an empty string", () => {
    expect(isUrlOnly("")).toBe(false);
  });

  it("is false for a non-http(s) scheme", () => {
    expect(isUrlOnly("javascript:alert(1)")).toBe(false);
    expect(isUrlOnly("mailto:a@b.com")).toBe(false);
  });

  it("is false once trailing punctuation is trimmed off the URL, leaving stray text", () => {
    // linkifyMessage trims a trailing "." into its own text segment — so
    // "https://example.com." is a link segment PLUS a one-character text
    // segment, not a single bare-URL segment.
    expect(isUrlOnly("https://example.com.")).toBe(false);
  });
});
