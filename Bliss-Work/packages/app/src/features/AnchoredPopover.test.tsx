// @vitest-environment jsdom
import { useRef } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnchoredPopover } from "./AnchoredPopover";

const originalViewport = { width: window.innerWidth, height: window.innerHeight };

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

function Fixture() {
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  return (
    <div
      data-testid="clipping-shell"
      style={{ overflow: "hidden", isolation: "isolate", filter: "opacity(1)", transform: "translateZ(0)" }}
    >
      <header style={{ position: "sticky", zIndex: 50 }}>Navigation</header>
      <div ref={anchor} data-testid="anchor" />
      <AnchoredPopover
        anchor={anchor}
        panelRef={panel}
        gap={8}
        data-testid="panel"
        role="menu"
        className="h-48 w-52 overflow-y-auto rounded-xl border bg-surface shadow-card"
      >
        <button role="menuitem">Menu action</button>
      </AnchoredPopover>
      <div>Page content</div>
    </div>
  );
}

function renderAt(left: number, top: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === "anchor") return rect(left, top, 32, 32);
    return rect(0, 0, 0, 0);
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "panel" ? 208 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === "panel" ? 192 : 0;
  });
  render(<Fixture />);
}

beforeEach(() => {
  window.innerWidth = 1000;
  window.innerHeight = 800;
});

afterEach(() => {
  vi.restoreAllMocks();
  window.innerWidth = originalViewport.width;
  window.innerHeight = originalViewport.height;
});

describe("AnchoredPopover", () => {
  it("escapes clipped stacking contexts and stays aligned near the top-right edge", () => {
    renderAt(950, 8);
    const panel = screen.getByRole("menu");

    expect(panel.parentElement).toBe(document.body);
    expect(panel).toHaveClass("fixed", "z-[var(--z-dropdown)]");
    expect(panel.style.top).toBe("48px");
    expect(panel.style.left).toBe("774px");
    expect(panel).toContainElement(screen.getByRole("menuitem", { name: "Menu action" }));
  });

  it("flips above a trigger near the bottom and clamps to the left viewport edge", () => {
    renderAt(0, 760);
    const panel = screen.getByRole("menu");

    expect(panel.parentElement).toBe(document.body);
    expect(panel).toHaveStyle({ top: "560px", left: "8px" });
    expect(panel.style.maxHeight).toBe("752px");
    expect(panel.style.maxWidth).toBe("984px");
  });
});
