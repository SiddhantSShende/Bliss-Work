/**
 * The drag strip is how the desktop main window is moved on screens without the
 * app-shell header. It must exist only there, and must never sit over a control.
 */
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopDragStrip } from "./DesktopDragStrip";

const h = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: {}, config: h.config }) }));

const strip = () => document.querySelector<HTMLElement>("[aria-hidden]");
const at = (path: string, extra?: React.ReactNode) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <DesktopDragStrip />
      {extra}
    </MemoryRouter>,
  );

describe("DesktopDragStrip", () => {
  beforeEach(() => {
    h.config = { kind: "electron", windowControls: { side: "right", setTheme: vi.fn() } };
  });
  afterEach(() => vi.restoreAllMocks());

  it("is the drag handle on screens outside the app shell", () => {
    at("/login");
    expect(strip()).toHaveClass("app-drag", "app-titlebar");
  });

  it("is absent under /app, where TopNavbar is the header", () => {
    at("/app/mail");
    expect(strip()).toBeNull();
  });

  it("is absent on web and on the meeting window (no windowControls)", () => {
    h.config = { kind: "web" };
    at("/login");
    expect(strip()).toBeNull();
  });

  it("stops being a drag region while a control sits inside it", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const box = (left: number, right: number, top: number, bottom: number) =>
        ({ left, right, top, bottom, width: right - left, height: bottom - top, x: left, y: top }) as DOMRect;
      return this.tagName === "BUTTON" ? box(10, 60, 10, 30) : box(0, 1000, 0, 48);
    });
    at("/onboarding", <button>Go</button>);
    await waitFor(() => expect(strip()).toHaveClass("app-no-drag"));
    expect(strip()).not.toHaveClass("app-drag");
  });
});
