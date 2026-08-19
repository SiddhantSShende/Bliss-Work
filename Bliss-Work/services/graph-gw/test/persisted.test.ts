/**
 * Trusted documents. The property under test is not "persisted queries work" —
 * it is that a client CANNOT get an unregistered document executed when the
 * allow-list is on, and that it is told so rather than being silently served a
 * different one.
 */
import { describe, expect, it } from "vitest";
import { GRAPHQL_OPERATIONS } from "@taskboard/shared";
import { resolvePersistedParams } from "../src/persisted.js";

const LOCKED = { allowArbitrary: false };
const OPEN = { allowArbitrary: true };

describe("resolvePersistedParams", () => {
  it("substitutes the registered document for a known operation name", () => {
    const out = resolvePersistedParams({ operationName: "InboxOverview" }, LOCKED);
    expect(out.query).toBe(GRAPHQL_OPERATIONS.InboxOverview);
    expect(out.operationName).toBe("InboxOverview");
  });

  it("carries variables through untouched", () => {
    const variables = { kinds: ["MAIL"] };
    const out = resolvePersistedParams({ operationName: "InboxOverview", variables }, LOCKED);
    expect(out.variables).toBe(variables);
  });

  it("refuses an inline query rather than ignoring it", () => {
    // Silently dropping the document would let a caller believe theirs ran.
    expect(() =>
      resolvePersistedParams(
        { operationName: "InboxOverview", query: "{ __typename }" },
        LOCKED,
      ),
    ).toThrow(/only registered operations/);
  });

  it("refuses an unregistered operation name", () => {
    expect(() => resolvePersistedParams({ operationName: "DrainTheOrg" }, LOCKED)).toThrow(
      /unknown operation/,
    );
  });

  it("does not enumerate the registry in the refusal", () => {
    // This branch is reachable before authentication; the registry is a map of
    // the product's data access.
    try {
      resolvePersistedParams({ operationName: "DrainTheOrg" }, LOCKED);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(String(err)).not.toContain("InboxOverview");
    }
  });

  it("refuses a request carrying neither a name nor a document", () => {
    expect(() => resolvePersistedParams({}, LOCKED)).toThrow(/operationName is required/);
  });

  it("treats a blank query as absent, not as an inline document", () => {
    const out = resolvePersistedParams({ operationName: "InboxOverview", query: "   " }, LOCKED);
    expect(out.query).toBe(GRAPHQL_OPERATIONS.InboxOverview);
  });

  it("is not fooled by a name inherited from Object.prototype", () => {
    // `hasOwnProperty` rather than `in`/truthiness: "constructor" and "toString"
    // are truthy lookups on any plain object.
    expect(() => resolvePersistedParams({ operationName: "constructor" }, LOCKED)).toThrow(
      /unknown operation/,
    );
    expect(() => resolvePersistedParams({ operationName: "toString" }, LOCKED)).toThrow(
      /unknown operation/,
    );
  });

  it("lets an inline document through only when arbitrary queries are enabled", () => {
    const params = { query: "{ __typename }" };
    expect(resolvePersistedParams(params, OPEN)).toBe(params);
  });

  it("still resolves registered names when arbitrary queries are enabled", () => {
    const out = resolvePersistedParams({ operationName: "InboxOverview" }, OPEN);
    expect(out.query).toBe(GRAPHQL_OPERATIONS.InboxOverview);
  });
});

describe("the registry itself", () => {
  it("names every document after the operation it declares", () => {
    // The name IS the id clients send. A registry entry whose text declares a
    // different operation name would resolve to a document Yoga then cannot
    // find the operation in — a confusing runtime failure, caught here instead.
    for (const [name, document] of Object.entries(GRAPHQL_OPERATIONS)) {
      expect(document).toMatch(new RegExp(`\\b(query|mutation)\\s+${name}\\b`));
    }
  });

  it("registers no mutations — writes deliberately stay on REST", () => {
    for (const document of Object.values(GRAPHQL_OPERATIONS)) {
      expect(document).not.toMatch(/\bmutation\s/);
    }
  });
});
