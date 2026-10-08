import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * index.ts boots Electron on import, so the quit flow cannot be driven here.
 * These pin the structural contract instead: tray/menu Quit (`quitApp`) must
 * leave meeting windows alive so `before-quit` can run the graceful-leave
 * handshake (leaveCall + resume-meeting marker clear) before `finishQuit`
 * destroys them. Real-Electron behaviour is NOT covered.
 */
const source = readFileSync(join(__dirname, "index.ts"), "utf8");

function functionBody(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

// Comments may legitimately mention the call; only code counts.
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("quit flow", () => {
  it("quitApp does not destroy meeting windows before before-quit can ask them to leave", () => {
    const body = stripComments(functionBody("quitApp"));
    expect(body).not.toMatch(/meetingWindows\s*\.\s*destroyAll/);
    expect(body).toMatch(/app\.quit\(\)/);
  });

  it("before-quit still waits on live meeting windows, then finishQuit destroys them", () => {
    const handler = source.slice(source.indexOf('app.on("before-quit", (e)'));
    expect(handler).toContain("meetingWindows");
    expect(handler).toContain('"app:before-quit"');
    expect(stripComments(functionBody("finishQuit"))).toMatch(/meetingWindows\s*\.\s*destroyAll\(\)/);
  });
});
