/**
 * The scroll box of a paged picker: it asks for the next page near its bottom, and also when
 * what is loaded does not yet fill it (otherwise there would be nothing to scroll). jsdom has
 * no layout, so the box's geometry is supplied.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PickerScrollList } from "./PickerScrollList";

const text = { loading: "Loading…", loadingMore: "More…", error: "Failed", retry: "Retry", empty: "Nothing" };

function geometry(client: number, scroll: number) {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(client);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(scroll);
}

function list(props: Partial<React.ComponentProps<typeof PickerScrollList>> = {}) {
  const onNearEnd = vi.fn();
  render(
    <PickerScrollList
      tone="light"
      label="People"
      isLoading={false}
      isError={false}
      isLoadingMore={false}
      hasMore
      isEmpty={false}
      onNearEnd={onNearEnd}
      onRetry={vi.fn()}
      text={text}
      {...props}
    >
      <button type="button">row</button>
    </PickerScrollList>,
  );
  return { onNearEnd, box: screen.getByRole("region", { name: "People" }) };
}

afterEach(() => vi.restoreAllMocks());

describe("PickerScrollList", () => {
  it("has a fixed height and its own scrollbar from the first render, empty, loading or full", () => {
    for (const props of [{ isLoading: true }, { isEmpty: true }, {}]) {
      const { box } = list(props);
      expect(box).toHaveClass("h-72", "overflow-y-auto");
      document.body.innerHTML = "";
    }
  });

  it("asks for more when what is loaded does not fill the box, with no scrolling needed", () => {
    geometry(240, 100);
    const { onNearEnd } = list();
    expect(onNearEnd).toHaveBeenCalled();
  });

  it("does not, when the rows already overflow the box and the user is far from the end", () => {
    geometry(240, 2000);
    const { onNearEnd, box } = list();
    Object.defineProperty(box, "scrollTop", { configurable: true, value: 100 });
    fireEvent.scroll(box);
    expect(onNearEnd).not.toHaveBeenCalled();
  });

  it("asks within ~96px of the bottom", () => {
    geometry(240, 2000);
    const { onNearEnd, box } = list();
    Object.defineProperty(box, "scrollTop", { configurable: true, value: 2000 - 240 - 95 });
    fireEvent.scroll(box);
    expect(onNearEnd).toHaveBeenCalledTimes(1);
  });

  it("never asks once there is no more, or while a page is already loading", () => {
    geometry(240, 100);
    const done = list({ hasMore: false });
    expect(done.onNearEnd).not.toHaveBeenCalled();
    document.body.innerHTML = "";
    const busy = list({ isLoadingMore: true });
    expect(busy.onNearEnd).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("More…");
  });

  it("keeps the rows and offers a retry when a LATER page fails", () => {
    list({ isError: true });
    expect(screen.getByRole("button", { name: "row" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
  });
});
