import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme, type CustomTheme } from "@taskboard/ui";
import { ApiError, type UserDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({ api: { me: vi.fn(), updateProfile: vi.fn() }, toastError: vi.fn() }));
vi.mock("./runtime", () => ({ useRuntime: () => ({ api: h.api }) }));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: vi.fn() } }));

import { useSession } from "../store/session";
import { ThemeSync, publishThemePrefs, notifyRemoteThemePrefsChanged } from "./themeSync";

let theme!: ReturnType<typeof useTheme>;
function Probe() {
  theme = useTheme();
  return null;
}

function TestTree() {
  const authenticated = useSession((state) => state.status === "authed");
  const accountId = useSession((state) => state.user?.id);
  return (
    <ThemeProvider
      authenticated={authenticated}
      accountId={accountId}
      onPrefsChange={(prefs) => publishThemePrefs(h.api as never, prefs, { notify: true })}
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
const themePrefsDTO = (theme: string, colors: string[] | null, customActive: boolean) => ({
  theme,
  customColors: colors,
  customActive,
});

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

describe("account-wide theme document", () => {
  it("adopts the account's preset, light/dark, Custom activation, and palette on a new session", async () => {
    h.api.me.mockResolvedValue({ themePrefs: themePrefsDTO("rose-dark", ["#112233"], true) });
    mount();

    await waitFor(() => expect(theme.theme).toBe("rose-dark"));
    expect(theme.customThemeActive).toBe(true);
    expect(theme.customTheme).toEqual(storedTheme(["#112233"]));
    // Custom is active, so the DOM renders the custom palette's inline tokens
    // (on the dark side of the preset, since "rose-dark" ends in "-dark"),
    // not the "rose" family class — see applyTheme.
    expect(hasClass("dark")).toBe(true);
    expect(hasClass("rose")).toBe(false);
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#112233");
    expect(h.api.updateProfile).not.toHaveBeenCalled();
  });

  it("publishes the whole document on a preset change, a toggle, saving Custom, and clearing it", async () => {
    h.api.me.mockResolvedValue({ themePrefs: null });
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalled());

    act(() => theme.setTheme("rose"));
    await waitFor(() =>
      expect(h.api.updateProfile).toHaveBeenNthCalledWith(1, {
        themePrefs: themePrefsDTO("rose", null, false),
        expectedThemeRevision: 0,
      }),
    );

    act(() => theme.toggle());
    await waitFor(() =>
      expect(h.api.updateProfile).toHaveBeenNthCalledWith(2, {
        themePrefs: themePrefsDTO("rose-dark", null, false),
        expectedThemeRevision: 1,
      }),
    );

    act(() => theme.saveCustomTheme(storedTheme(["#112233"])));
    await waitFor(() =>
      expect(h.api.updateProfile).toHaveBeenNthCalledWith(3, {
        themePrefs: themePrefsDTO("rose-dark", ["#112233"], true),
        expectedThemeRevision: 2,
      }),
    );

    act(() => theme.clearCustomTheme());
    await waitFor(() =>
      expect(h.api.updateProfile).toHaveBeenNthCalledWith(4, {
        themePrefs: themePrefsDTO("rose-dark", null, false),
        expectedThemeRevision: 3,
      }),
    );
  });

  it("migrates a local-only choice to the account only when it has never synced from any device", async () => {
    localStorage.setItem("tb-theme", "teal-dark");
    h.api.me.mockResolvedValue({ themePrefs: null });
    mount();

    await waitFor(() =>
      expect(h.api.updateProfile).toHaveBeenCalledWith({
        themePrefs: themePrefsDTO("teal-dark", null, false),
        expectedThemeRevision: 0,
      }),
    );
  });

  it("does not publish a brand-new device's untouched default onto an also-never-synced account", async () => {
    h.api.me.mockResolvedValue({ themePrefs: null });
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalled());
    expect(h.api.updateProfile).not.toHaveBeenCalled();
    expect(theme.theme).toBe("bluePurple");
  });

  it("pulls a later change on focus, overwriting this device's own prior selection", async () => {
    h.api.me.mockResolvedValue({ themePrefs: themePrefsDTO("purple", null, false) });
    mount();
    await waitFor(() => expect(theme.theme).toBe("purple"));

    h.api.me.mockResolvedValue({ themePrefs: themePrefsDTO("teal-dark", ["#eeeeee"], true) });
    await refocus();
    await waitFor(() => expect(theme.theme).toBe("teal-dark"));
    expect(theme.customThemeActive).toBe(true);
    expect(theme.customTheme).toEqual(storedTheme(["#eeeeee"]));
    expect(h.api.updateProfile).not.toHaveBeenCalled();
  });

  it("pulls a remote change immediately on a server push, without waiting for focus", async () => {
    h.api.me.mockResolvedValue({ themePrefs: themePrefsDTO("purple", null, false) });
    mount();
    await waitFor(() => expect(theme.theme).toBe("purple"));

    h.api.me.mockResolvedValue({ themePrefs: themePrefsDTO("lime-dark", null, false) });
    await act(async () => notifyRemoteThemePrefsChanged());
    await waitFor(() => expect(theme.theme).toBe("lime-dark"));
    expect(h.api.me).toHaveBeenCalledTimes(2);
    expect(h.api.updateProfile).not.toHaveBeenCalled();
  });

  it("keeps the latest server preference when a stale concurrent write is rejected", async () => {
    h.api.me.mockResolvedValue({ themePrefs: null, customThemeRevision: 0 });
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalledTimes(1));
    h.api.me.mockResolvedValue({
      themePrefs: themePrefsDTO("teal", null, false),
      customThemeRevision: 5,
    });
    h.api.updateProfile.mockRejectedValueOnce(new ApiError(409, "revision conflict"));

    act(() => theme.setTheme("rose"));
    await waitFor(() => expect(theme.theme).toBe("teal"));
    expect(h.api.updateProfile).toHaveBeenCalledTimes(1);
    expect(h.api.updateProfile.mock.calls[0]?.[0].expectedThemeRevision).toBe(0);
  });

  it("does not retry a stale choice when conflict reconciliation is offline", async () => {
    h.api.me.mockResolvedValue({ themePrefs: null, customThemeRevision: 0 });
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalledTimes(1));
    h.api.updateProfile.mockRejectedValueOnce(new ApiError(409, "revision conflict"));
    h.api.me.mockRejectedValue(new Error("offline"));

    act(() => theme.setTheme("rose"));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    h.api.me.mockResolvedValue({ themePrefs: themePrefsDTO("teal", null, false), customThemeRevision: 5 });
    await refocus();

    await waitFor(() => expect(theme.theme).toBe("teal"));
    expect(h.api.updateProfile).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default for a theme id this build does not recognize", async () => {
    h.api.me.mockResolvedValue({ themePrefs: themePrefsDTO("future-theme-id", null, false) });
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalled());
    expect(theme.theme).toBe("bluePurple");
  });

  it("drops Custom activation from a remote row with no valid palette, without crashing", async () => {
    h.api.me.mockResolvedValue({ themePrefs: themePrefsDTO("rose", null, true) });
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalled());
    expect(theme.customThemeActive).toBe(false);
    expect(theme.customTheme).toBeNull();
    expect(theme.theme).toBe("rose");
  });

  it("ignores a stale GET racing a fresh local change (no revert)", async () => {
    let resolveMe!: (v: unknown) => void;
    h.api.me.mockReturnValueOnce(new Promise((resolve) => (resolveMe = resolve)));
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalledTimes(1));

    // A local change happens while the first GET is still in flight.
    act(() => theme.setTheme("rose"));
    resolveMe({ themePrefs: themePrefsDTO("purple", null, false) });

    // The stale read must not snap the fresh local choice back.
    await waitFor(() => expect(h.api.updateProfile).toHaveBeenCalled());
    expect(theme.theme).toBe("rose");
  });

  it("retries an unsynced change on focus and tells the user once", async () => {
    h.api.me.mockResolvedValue({ themePrefs: null });
    const first = mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalled());
    h.api.updateProfile.mockRejectedValueOnce(new Error("offline"));

    first.unmount();
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalledTimes(2));
    expect(theme.theme).toBe("bluePurple");
    expect(h.api.updateProfile).not.toHaveBeenCalled();

    act(() => theme.setTheme("rose"));
    await waitFor(() => expect(h.api.updateProfile).toHaveBeenCalledTimes(1));
    await refocus();
    await waitFor(() => expect(h.api.updateProfile).toHaveBeenCalledTimes(2));
    expect(h.api.updateProfile).toHaveBeenLastCalledWith({
      themePrefs: themePrefsDTO("rose", null, false),
      expectedThemeRevision: 0,
    });
    expect(h.toastError).toHaveBeenCalledTimes(1);
  });

  it("does not fetch or sync until authentication is confirmed", async () => {
    useSession.setState({ status: "loading", user: null });
    h.api.me.mockResolvedValue({ themePrefs: null });
    mount();
    expect(theme.theme).toBe("bluePurple");
    expect(h.api.me).not.toHaveBeenCalled();

    await act(async () => useSession.setState({ status: "authed", user: { id: "u1" } as UserDTO }));
    await waitFor(() => expect(h.api.me).toHaveBeenCalledTimes(1));
  });

  it("clears the active account theme on logout and stops publishing", async () => {
    h.api.me.mockResolvedValue({ themePrefs: themePrefsDTO("rose-dark", null, false) });
    mount();
    await waitFor(() => expect(theme.theme).toBe("rose-dark"));

    await act(async () => useSession.setState({ status: "anon", user: null }));
    expect(theme.theme).toBe("bluePurple");
    act(() => theme.setTheme("teal"));
    expect(h.api.updateProfile).not.toHaveBeenCalled();
  });

  it("clears a different account's pending unsynced change on login, never leaking it forward", async () => {
    h.api.me.mockResolvedValue({ themePrefs: null });
    const first = mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalled());
    h.api.updateProfile.mockRejectedValueOnce(new Error("offline"));
    act(() => theme.setTheme("rose"));
    await waitFor(() => expect(h.api.updateProfile).toHaveBeenCalledTimes(1));
    first.unmount();

    // A DIFFERENT account logs in on this device.
    useSession.setState({ status: "authed", user: { id: "u2" } as UserDTO });
    h.api.me.mockResolvedValue({ themePrefs: themePrefsDTO("teal", null, false) });
    mount();

    await waitFor(() => expect(theme.theme).toBe("teal"));
    // u1's unsynced retry must never fire under u2's session.
    expect(h.api.updateProfile).toHaveBeenCalledTimes(1);
  });

  it("does not hydrate a new account from the previous account's local theme", async () => {
    localStorage.setItem("tb-theme", "rose-dark");
    localStorage.setItem("tb-theme-owner", "u1");
    useSession.setState({ status: "authed", user: { id: "u2" } as UserDTO });
    h.api.me.mockResolvedValue({ themePrefs: null, customThemeRevision: 0 });

    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalledTimes(1));
    expect(theme.theme).toBe("bluePurple");
    expect(localStorage.getItem("tb-theme")).toBeNull();
    expect(h.api.updateProfile).not.toHaveBeenCalled();
  });
});
