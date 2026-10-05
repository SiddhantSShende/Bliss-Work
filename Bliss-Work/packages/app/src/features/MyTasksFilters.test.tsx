import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NO_SENT_FILTER, type SentTaskFilter } from "../lib/sentTaskFilter";
import { MyTasksFilters } from "./MyTasksFilters";

const PEOPLE = ["ann", "ben", "cy", "di", "ed"].map((name) => ({ id: `u-${name}`, username: name }));

function Harness({ onFilter }: { onFilter: (f: SentTaskFilter) => void }) {
  const [filter, setFilter] = useState(NO_SENT_FILTER);
  return (
    <MyTasksFilters
      filter={filter}
      onChange={(f) => { setFilter(f); onFilter(f); }}
      people={PEOPLE}
      nameOf={(_id, fallback) => fallback ?? ""}
      avatarUrlOf={() => null}
    />
  );
}
const chips = () => screen.queryByRole("list", { name: "Selected people" });

describe("MyTasksFilters people", () => {
  it("selects several people with checkboxes and shows each as a removable chip", async () => {
    const user = userEvent.setup();
    let last = NO_SENT_FILTER;
    render(<Harness onFilter={(f) => (last = f)} />);
    expect(chips()).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "ann" }));
    await user.click(screen.getByRole("checkbox", { name: "cy" }));
    expect([...last.personIds]).toEqual(["u-ann", "u-cy"]);
    expect(within(chips()!).getAllByRole("listitem")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Remove ann" }));
    expect([...last.personIds]).toEqual(["u-cy"]);
    expect(screen.getByRole("checkbox", { name: "ann" })).not.toBeChecked();
  });

  it("searches by name without losing the selection", async () => {
    const user = userEvent.setup();
    render(<Harness onFilter={() => {}} />);
    await user.click(screen.getByRole("checkbox", { name: "ben" }));

    await user.type(screen.getByRole("searchbox", { name: "Search people…" }), "d");
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "di" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "ed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove ben" })).toBeInTheDocument();

    await user.type(screen.getByRole("searchbox", { name: "Search people…" }), "zzz");
    expect(screen.getByText("No people match")).toBeInTheDocument();
  });

  it("folds chips past three into +N, which opens them all", async () => {
    const user = userEvent.setup();
    render(<Harness onFilter={() => {}} />);
    for (const name of ["ann", "ben", "cy", "di", "ed"]) await user.click(screen.getByRole("checkbox", { name }));

    expect(within(chips()!).getAllByRole("button", { name: /^Remove / })).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "+2" }));
    expect(within(chips()!).getAllByRole("button", { name: /^Remove / })).toHaveLength(5);
    await user.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(within(chips()!).getAllByRole("button", { name: /^Remove / })).toHaveLength(3);
  });

  it("keeps the list in its own scroll area", () => {
    render(<Harness onFilter={() => {}} />);
    expect(screen.getByRole("checkbox", { name: "ann" }).closest("ul")).toHaveClass("overflow-y-auto", "max-h-48");
  });
});
