/**
 * Address validation parity.
 *
 * Three implementations decide whether an address is deliverable — this one
 * (the composer's Send gate), messaging-svc's NormalizeMailAddress, and
 * email-worker's is_valid_email — and they MUST agree. A composer that accepts
 * what the server rejects turns a typo into a failed send after the fact; one
 * that rejects what the server accepts makes a deliverable mail unsendable,
 * which is worse because the user cannot argue with it.
 *
 * The cases below are deliberately the same set pinned in
 * services/messaging-svc/internal/store/mail_test.go and
 * services/email-worker/tests/test_mailer.py. Changing one without the others
 * is the bug these three files exist to catch.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_MAIL_ADDRESS_LENGTH,
  isValidMailAddress,
  normalizeMailAddress,
  splitMailAddresses,
} from "./mailAddress";

describe("normalizeMailAddress", () => {
  it.each([
    ["user@example.com", "user@example.com"],
    ["u@d.co", "u@d.co"],
    ["first.last@sub.domain.org", "first.last@sub.domain.org"],
    ["a+tag@example.io", "a+tag@example.io"],
    ["  trimmed@example.com  ", "trimmed@example.com"],
  ])("accepts %s", (input, want) => {
    expect(normalizeMailAddress(input)).toBe(want);
  });

  // Matching the org directory depends on both sides agreeing on one form, and
  // nobody types a colleague's address with consistent capitalisation.
  it("lower-cases so a send matches the directory regardless of capitalisation", () => {
    expect(normalizeMailAddress("Jane.Okafor@ACME.com")).toBe("jane.okafor@acme.com");
  });

  it.each([
    "not-an-email",
    "@d",
    "u@",
    "",
    "   ",
    "no-at-symbol.com",
    "two@@at.com",
    "user@host",
    "user @host.com",
    "user@ho st.com",
  ])("rejects %s", (input) => {
    expect(normalizeMailAddress(input)).toBe("");
    expect(isValidMailAddress(input)).toBe(false);
  });

  // Rejected, not truncated: half an address is not a different address, it is
  // a wrong one, and RFC 5321 caps what any server must accept.
  it("rejects an address past the RFC length ceiling", () => {
    const long = `${"a".repeat(MAX_MAIL_ADDRESS_LENGTH)}@example.com`;
    expect(normalizeMailAddress(long)).toBe("");
  });
});

describe("splitMailAddresses", () => {
  // People paste recipient lists out of other mail clients, spreadsheets and
  // chat messages. Each of these separators shows up in practice, and without
  // the split a paste becomes one long invalid token.
  it.each([
    ["a@x.com, b@x.com", ["a@x.com", "b@x.com"]],
    ["a@x.com; b@x.com", ["a@x.com", "b@x.com"]],
    ["a@x.com\nb@x.com", ["a@x.com", "b@x.com"]],
    ["a@x.com b@x.com", ["a@x.com", "b@x.com"]],
    ["  a@x.com ,, ; b@x.com  ", ["a@x.com", "b@x.com"]],
  ])("splits %s", (input, want) => {
    expect(splitMailAddresses(input)).toEqual(want);
  });

  it("returns nothing for an empty or whitespace-only paste", () => {
    expect(splitMailAddresses("   \n ")).toEqual([]);
  });
});
