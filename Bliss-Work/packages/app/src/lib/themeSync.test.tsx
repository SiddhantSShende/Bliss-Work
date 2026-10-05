import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme, type CustomTheme } from "@taskboard/ui";
import type { UserDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({ api: { me: vi.fn(), updateProfile: vi.fn() }, toastError: vi.fn() }));
vi.mock("./runtime", () => ({ useRuntime: () => ({ api: h.api }) }));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: vi.fn() } }));

import { useSession } from "../store/session";
import { ThemeSync, publishCustomTheme } from "./themeSync";

let theme!: ReturnType<typeof useTheme>;
function Probe() {
  theme = useTheme();
  return null;
}

function TestTree() {
  const authenticated = useSession((state) => state.status === "authed");
  return (
    <ThemeProvider
      authenticated={authenticated}
      onCustomThemeChange={(customTheme) => publishCustomTheme(h.api as never, customTheme, { notify: true })}
    >
      <ThemeSync />
      <Probe />
    </ThemeProvider>
  );
}

function mount() {
  return render(<TestTree />);
}

const hasClass = (name: string) => document.documentElement.classList.contains(name);
const storedTheme = (colors: string[]): CustomTheme => ({ colors });

let now = 1_000_000_000_000;
async function refocus() {
  now += 11_000;
  await act(async () => window.dispatchEvent(new Event("focus")));
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
  h.api.me.mockReset();
  h.api.updateProfile.mockReset().mockResolvedValue({});
  h.toastError.mockReset();
  useSession.setState({ status: "authed", user: { id: "u1" } as UserDTO });
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

describe("shared custom-theme definitions", () => {
  it("adopts the account definition without changing this device's selection", async () => {
    localStorage.setItem("tb-theme", "teal-dark");
    localStorage.setItem("tb-custom-theme-active", "false");
    h.api.me.mockResolvedValue({
      themePrefs: { theme: "rose-dark", customColors: ["#112233"], customActive: true },
      customTheme: storedTheme(["#112233"]),
      customThemeRevision: 1,
    });
    mount();

    await waitFor(() => expect(theme.customTheme).toEqual(storedTheme(["#112233"])));
    expect(theme.theme).toBe("teal-dark");
    expect(theme.customThemeActive).toBe(false);
    expect(hasClass("teal")).toBe(true);
    expect(hasClass("rose")).toBe(false);
    expect(h.api.updateProfile).not.toHaveBeenCalled();
  });

  it("reads a legacy combined preference as a definition only", async () => {
    localStorage.setItem("tb-theme", "purple");
    h.api.me.mockResolvedValue({
      themePrefs: { theme: "rose-dark", customColors: ["#abcdef"], customActive: true },
      customThemeRevision: null,
    });
    mount();

    await waitFor(() => expect(theme.customTheme).toEqual(storedTheme(["#abcdef"])));
    expect(theme.theme).toBe("purple");
    expect(theme.customThemeActive).toBe(false);
    expect(h.api.updateProfile).not.toHaveBeenCalled();
  });

  it("migrates a local legacy definition only when the account has no theme record", async () => {
    localStorage.setItem("tb-custom-theme", JSON.stringify(storedTheme(["#123456"])));
    h.api.me.mockResolvedValue({ themePrefs: null, customThemeRevision: null });
    mount();

    await waitFor(() => expect(h.api.updateProfile).toHaveBeenCalledWith({ customTheme: storedTheme(["#123456"]) }));
    expect(theme.theme).toBe("bluePurple");
  });

  it("publishes create, update, and explicit deletion without sending selection", async () => {
    h.api.me.mockResolvedValue({ customTheme: null, customThemeRevision: 1, themePrefs: null });
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalled());

    act(() => theme.saveCustomTheme(storedTheme(["#112233"])));
    await waitFor(() => expect(h.api.updateProfile).toHaveBeenNthCalledWith(1, { customTheme: storedTheme(["#112233"]) }));
    act(() => theme.saveCustomTheme(storedTheme(["#112233", "#445566"])));
    await waitFor(() => expect(h.api.updateProfile).toHaveBeenNthCalledWith(2, { customTheme: storedTheme(["#112233", "#445566"]) }));
    act(() => theme.clearCustomTheme());
    await waitFor(() => expect(h.api.updateProfile).toHaveBeenNthCalledWith(3, { customTheme: null }));

    expect(theme.theme).toBe("bluePurple");
    expect(theme.customTheme).toBeNull();
    expect(localStorage.getItem("tb-custom-theme")).toBeNull();
    expect(h.api.updateProfile.mock.calls.every(([body]) => !("themePrefs" in body))).toBe(true);
  });

  it("keeps preset and appearance selection local", async () => {
    h.api.me.mockResolvedValue({ customTheme: null, customThemeRevision: 1, themePrefs: null });
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalled());

    act(() => theme.setTheme("rose"));
    act(() => theme.toggle());
    expect(theme.theme).toBe("rose-dark");
    expect(h.api.updateProfile).not.toHaveBeenCalled();
  });

  it("honors a versioned deletion instead of resurrecting the cached definition", async () => {
    localStorage.setItem("tb-theme", "teal");
    localStorage.setItem("tb-custom-theme", JSON.stringify(storedTheme(["#112233"])));
    localStorage.setItem("tb-custom-theme-active", "true");
    h.api.me.mockResolvedValue({ customTheme: null, customThemeRevision: 2, themePrefs: null });
    mount();

    await waitFor(() => expect(theme.customTheme).toBeNull());
    expect(theme.theme).toBe("teal");
    expect(theme.customThemeActive).toBe(false);
    expect(localStorage.getItem("tb-custom-theme")).toBeNull();
    expect(h.api.updateProfile).not.toHaveBeenCalled();
  });

  it("pulls later definition updates on focus without changing selection", async () => {
    localStorage.setItem("tb-theme", "purple");
    h.api.me.mockResolvedValue({ customTheme: storedTheme(["#111111"]), customThemeRevision: 1, themePrefs: null });
    mount();
    await waitFor(() => expect(theme.customTheme).toEqual(storedTheme(["#111111"])));


  it("updates an active custom palette without changing the selected theme", async () => {
    localStorage.setItem("tb-theme", "rose-dark");
    localStorage.setItem("tb-custom-theme", JSON.stringify(storedTheme(["#111111"])));
    localStorage.setItem("tb-custom-theme-active", "true");
    h.api.me.mockResolvedValue({ customTheme: storedTheme(["#eeeeee"]), customThemeRevision: 2, themePrefs: null });
    mount();

    await waitFor(() => expect(theme.customTheme).toEqual(storedTheme(["#eeeeee"])));
    expect(theme.theme).toBe("rose-dark");
    expect(theme.customThemeActive).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#eeeeee");
  });
    h.api.me.mockResolvedValue({ customTheme: storedTheme(["#eeeeee"]), customThemeRevision: 2, themePrefs: null });
    await refocus();
    await waitFor(() => expect(theme.customTheme).toEqual(storedTheme(["#eeeeee"])));
    expect(theme.theme).toBe("purple");
    expect(theme.customThemeActive).toBe(false);
    expect(h.api.updateProfile).not.toHaveBeenCalled();
  });

  it("retries an unsynced definition on focus", async () => {
    h.api.me.mockResolvedValue({ customTheme: null, customThemeRevision: 2, themePrefs: null });
    const first = mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalled());
    h.api.updateProfile.mockRejectedValueOnce(new Error("offline"));

    first.unmount();
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalledTimes(2));
    expect(theme.customTheme).toBeNull();
    expect(theme.theme).toBe("teal");
    expect(h.api.updateProfile).not.toHaveBeenCalled();

    act(() => theme.saveCustomTheme(storedTheme(["#112233"])));
    await waitFor(() => expect(h.api.updateProfile).toHaveBeenCalledTimes(1));
    await refocus();
    await waitFor(() => expect(h.api.updateProfile).toHaveBeenCalledTimes(2));
    expect(h.api.updateProfile).toHaveBeenLastCalledWith({ customTheme: storedTheme(["#112233"]) });
    expect(h.toastError).toHaveBeenCalledTimes(1);
  });

  it("does not fetch or sync until authentication is confirmed", async () => {
    useSession.setState({ status: "loading", user: null });
    h.api.me.mockResolvedValue({ customTheme: null, customThemeRevision: 1, themePrefs: null });
    mount();
    expect(theme.theme).toBe("bluePurple");
    expect(h.api.me).not.toHaveBeenCalled();

    await act(async () => useSession.setState({ status: "authed", user: { id: "u1" } as UserDTO }));
    await waitFor(() => expect(h.api.me).toHaveBeenCalledTimes(1));
  });
});