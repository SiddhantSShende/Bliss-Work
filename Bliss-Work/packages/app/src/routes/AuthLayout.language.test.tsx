import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ config: {}, api: {} }) }));

import { AuthLayout } from "./Onboarding";

// Before sign-in there is no TopNavbar, so the selector has to live on the auth
// screens themselves — otherwise a person who cannot read the default language
// has no way to change it.
describe("AuthLayout language selector", () => {
  it("is available on the sign-in / sign-up screens without a session", async () => {
    render(
      <MemoryRouter>
        <AuthLayout title="Sign in">
          <p>form</p>
        </AuthLayout>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /language/i }));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(9);
    expect(screen.getByRole("menuitemradio", { name: "日本語" })).toBeInTheDocument();
  });
});
