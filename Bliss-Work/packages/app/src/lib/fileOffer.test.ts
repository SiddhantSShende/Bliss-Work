/**
 * A file offer's envelope is written by the other party. `parseFileOffer` only
 * checked the two id fields, so an offer whose `name` was an object (or whose
 * `size` was not a number) went to the bubble as-is and React threw while
 * rendering it, crashing the whole chat view.
 */
import { describe, expect, it } from "vitest";
import { encodeFileOffer, parseFileOffer } from "./fileOffer";

const SENTINEL = String.fromCharCode(0x1f);
const offerWith = (envelope: unknown) => `📎 file${SENTINEL}${JSON.stringify(envelope)}`;
const valid = { v: 1, offerId: "o-1", sha256: "abc", name: "report.pdf", size: 2048, mime: "application/pdf" };

describe("parseFileOffer", () => {
  it("round-trips an offer this client encoded", () => {
    const body = encodeFileOffer({ offerId: "o-1", name: "report.pdf", size: 2048, sha256: "abc", mime: "application/pdf" });

    expect(parseFileOffer(body)).toEqual(valid);
  });

  it("returns null for plain text", () => {
    expect(parseFileOffer("hello")).toBeNull();
  });

  it.each([
    ["not JSON", `x${SENTINEL}{oops`],
    ["a JSON array", offerWith([1, 2])],
    ["null", offerWith(null)],
    ["the wrong version", offerWith({ ...valid, v: 2 })],
    ["a missing offerId", offerWith({ ...valid, offerId: undefined })],
    ["a non-string sha256", offerWith({ ...valid, sha256: 7 })],
  ])("rejects %s", (_name, body) => {
    expect(parseFileOffer(body)).toBeNull();
  });

  it("never lets a non-string name through to be rendered", () => {
    const offer = parseFileOffer(offerWith({ ...valid, name: { $$typeof: "boom" } }));

    expect(offer?.name).toBe("file");
  });

  it("caps an oversized name", () => {
    const offer = parseFileOffer(offerWith({ ...valid, name: "a".repeat(10_000) }));

    expect(offer?.name).toHaveLength(255);
  });

  it.each([
    ["a string", "12"],
    ["an object", { n: 1 }],
    ["negative", -5],
    ["null", null],
  ])("replaces a size that is %s with 0", (_name, size) => {
    expect(parseFileOffer(offerWith({ ...valid, size }))?.size).toBe(0);
  });

  it("falls back to a type that is never rendered inline when mime is not a string", () => {
    expect(parseFileOffer(offerWith({ ...valid, mime: ["image/png"] }))?.mime).toBe("application/octet-stream");
  });
});
