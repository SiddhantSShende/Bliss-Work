import { describe, expect, it } from "vitest";
import { captureChordOf, type CaptureKeyInput } from "./screenshot-guard";

const down = (over: Partial<CaptureKeyInput>): CaptureKeyInput => ({
  type: "keyDown",
  key: "a",
  ...over,
});

describe("captureChordOf", () => {
  it("names the PrintScreen key", () => {
    expect(captureChordOf(down({ key: "PrintScreen" }))).toBe("PrintScreen");
  });

  it("names the 'Print' alias some Linux keymaps send", () => {
    expect(captureChordOf(down({ key: "Print" }))).toBe("PrintScreen");
  });

  it("names each macOS capture chord", () => {
    for (const key of ["3", "4", "5"]) {
      expect(captureChordOf(down({ key, meta: true, shift: true }))).toBe(`Cmd+Shift+${key}`);
    }
  });

  it("ignores keyUp, so one press is one attempt rather than two", () => {
    expect(captureChordOf(down({ type: "keyUp", key: "PrintScreen" }))).toBeNull();
  });

  it("leaves ordinary typing alone", () => {
    expect(captureChordOf(down({ key: "4" }))).toBeNull();
    expect(captureChordOf(down({ key: "s", meta: true }))).toBeNull();
  });

  it("does not fire on Cmd+3 without Shift — that is a workspace switch, not a capture", () => {
    expect(captureChordOf(down({ key: "3", meta: true }))).toBeNull();
  });

  it("does not claim Cmd+Shift+6, which is not a capture chord", () => {
    expect(captureChordOf(down({ key: "6", meta: true, shift: true }))).toBeNull();
  });
});
