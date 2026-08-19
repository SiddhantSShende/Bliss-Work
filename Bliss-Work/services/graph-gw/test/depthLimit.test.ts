/**
 * Depth counting, including the two ways a naive counter is defeated: hiding
 * nesting behind a named fragment, and a fragment cycle that makes it recurse
 * forever.
 */
import { describe, expect, it } from "vitest";
import { parse, validate } from "graphql";
import { createDepthLimitRule, documentDepth } from "../src/depthLimit.js";
import { schema } from "../src/schema.js";

const depthOf = (source: string) => documentDepth(parse(source));

describe("documentDepth", () => {
  it("counts a flat selection as one", () => {
    expect(depthOf("{ me }")).toBe(1);
    expect(depthOf("{ me { id } }")).toBe(2);
  });

  it("counts nesting", () => {
    expect(depthOf("{ inboxPeers { user { id } } }")).toBe(3);
  });

  it("follows named fragments, which is how depth is usually smuggled past", () => {
    expect(
      depthOf(`
        { inboxPeers { ...peer } }
        fragment peer on InboxPeer { user { id } }
      `),
    ).toBe(3);
  });

  it("does not charge a level for an inline fragment", () => {
    expect(depthOf("{ inboxPeers { ... on InboxPeer { peerId } } }")).toBe(2);
  });

  it("terminates on a fragment cycle instead of recursing forever", () => {
    // Invalid, and another rule reports it — but this rule may run first, so it
    // must not hang the process on the way there.
    const cyclic = `
      { inboxPeers { ...a } }
      fragment a on InboxPeer { user { ...b } }
      fragment b on User { ...a }
    `;
    expect(() => depthOf(cyclic)).not.toThrow();
  });

  it("ignores an unknown fragment rather than throwing", () => {
    expect(() => depthOf("{ inboxPeers { ...missing } }")).not.toThrow();
  });

  it("reports the deepest of several operations in one document", () => {
    expect(
      depthOf(`
        query shallow { me { id } }
        query deep { inboxPeers { user { id } } }
      `),
    ).toBe(3);
  });
});

describe("createDepthLimitRule", () => {
  const validateWith = (source: string, max: number) =>
    validate(schema, parse(source), [createDepthLimitRule(max)]);

  it("accepts a document at the ceiling", () => {
    expect(validateWith("{ inboxPeers { user { id } } }", 3)).toHaveLength(0);
  });

  it("rejects a document past the ceiling and says how deep it was", () => {
    const errors = validateWith("{ inboxPeers { user { id } } }", 2);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/nested 3 levels deep; the maximum is 2/);
  });

  it("rejects depth smuggled behind a fragment", () => {
    expect(
      validateWith(
        `
        { inboxPeers { ...peer } }
        fragment peer on InboxPeer { user { id } }
      `,
        2,
      ),
    ).toHaveLength(1);
  });
});
