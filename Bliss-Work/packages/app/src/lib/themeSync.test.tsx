/**
 * Cross-device theme sync — the real ThemeProvider, ThemeSync and session store,
 * with only the network client stubbed.
 *
 * Each case is one of the ways two devices can disagree: first load with an
 * account copy, first load without one, a change on this device, a change on
 * the other one, and the races between them (a read that a local change
 * overtook; a push that failed).
 */
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme, type ThemePrefs } from "@taskboard/ui";
import { ApiError, type UserDTO } from "@taskboard/shared";

const h = vi.hoisted(() => ({ api: { me: vi.fn(), updateProfile: vi.fn() }, toastError: vi.fn() }));
vi.mock("./runtime", () => ({ useRuntime: () => ({ api: h.api }) }));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: vi.fn() } }));

import { useSession } from "../store/session";
import { ThemeSync, publishThemePrefs } from "./themeSync";

let theme!: ReturnType<typeof useTheme>;
function Probe() {
  theme = useTheme();
  return null;
}

function mount() {
  return render(
    <ThemeProvider onPrefsChange={(prefs) => publishThemePrefs(h.api as never, prefs, { notify: true })}>
      <ThemeSync />
      <Probe />
    </ThemeProvider>,
  );
}

const account = (over: Partial<ThemePrefs> = {}): ThemePrefs => ({
  theme: "blue",
  customColors: null,
  customActive: false,
  ...over,
});
const hasClass = (name: string) => document.documentElement.classList.contains(name);

let now = 1_000_000_000_000;
/** ThemeSync throttles pulls to one per 10s; step past it between "focuses". */
async function refocus() {
  now += 11_000;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
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

describe("initial load", () => {
  it("adopts the account's theme, custom palette included, without echoing it back", async () => {
    h.api.me.mockResolvedValue({
      themePrefs: account({ theme: "rose-dark", customColors: ["#112233", "#445566"], customActive: true }),
    });
    mount();
    await waitFor(() => expect(hasClass("rose")).toBe(true));
    expect(hasClass("dark")).toBe(true);
    expect(hasClass("custom-theme")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#112233");
    expect(localStorage.getItem("tb-theme")).toBe("rose-dark");
    expect(JSON.parse(localStorage.getItem("tb-custom-theme")!)).toEqual({ colors: ["#112233", "#445566"] });
    expect(localStorage.getItem("tb-custom-theme-active")).toBe("true");
    expect(h.api.updateProfile).not.toHaveBeenCalled();
  });

  it("publishes a choice this device already had when the account has none yet", async () => {
    localStorage.setItem("tb-theme", "teal");
    h.api.me.mockResolvedValue({ themePrefs: null });
    mount();
    await waitFor(() =>
      expect(h.api.updateProfile).toHaveBeenCalledWith({
        themePrefs: { theme: "teal", customColors: null, customActive: false },
      }),
    );
  });

  it("stays quiet when neither the account nor this device has chosen anything", async () => {
    h.api.me.mockResolvedValue({ themePrefs: null });
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalled());
    await act(async () => {});
    expect(h.api.updateProfile).not.toHaveBeenCalled();
  });

  it("ignores a theme id from a newer client it does not know", async () => {
    h.api.me.mockResolvedValue({ themePrefs: account({ theme: "nebula" }) });
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalled());
    await act(async () => {});
    expect(theme.theme).toBe("bluePurple");
  });

  it("does not talk to the server when nobody is signed in", async () => {
    useSession.setState({ status: "anon", user: null });
    mount();
    act(() => theme.setTheme("lime"));
    expect(h.api.me).not.toHaveBeenCalled();
    expect(h.api.updateProfile).not.toHaveBeenCalled();
    expect(theme.theme).toBe("lime");
  });
});

describe("changes made on this device", () => {
  beforeEach(() => h.api.me.mockResolvedValue({ themePrefs: account({ theme: "bluePurple" }) }));

  it("reports a preset pick, then the custom theme, then Light/Dark", async () => {
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalled());

    act(() => theme.setTheme("lime"));
    await waitFor(() =>
      expect(h.api.updateProfile).toHaveBeenLastCalledWith({
        themePrefs: { theme: "lime", customColors: null, customActive: false },
      }),
    );

    act(() => theme.saveCustomTheme({ colors: ["#ffee00"] }));
    await waitFor(() =>
      expect(h.api.updateProfile).toHaveBeenLastCalledWith({
        themePrefs: { theme: "lime", customColors: ["#ffee00"], customActive: true },
      }),
    );

    act(() => theme.toggle());
    await waitFor(() =>
      expect(h.api.updateProfile).toHaveBeenLastCalledWith({
        themePrefs: { theme: "lime-dark", customColors: ["#ffee00"], customActive: true },
      }),
    );
  });

  it("sends quick successive changes one at a time, latest last, so the account keeps the last pick", async () => {
    const sent: string[] = [];
    h.api.updateProfile.mockImplementation(async ({ themePrefs }: { themePrefs: ThemePrefs }) => {
      await new Promise((r) => setTimeout(r, 5));
      sent.push(themePrefs.theme);
      return {};
    });
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalled());
    act(() => theme.setTheme("rose"));
    act(() => theme.setTheme("teal"));
    act(() => theme.setTheme("purple"));
    await waitFor(() => expect(sent).toHaveLength(2));
    // "rose" was already in flight; "teal" was superseded by "purple" before it
    // was ever sent, and "purple" — the last pick — is what the account ends on.
    expect(sent).toEqual(["rose", "purple"]);
  });
});

describe("changes made on another device", () => {
  it("shows up the next time this window regains focus", async () => {
    h.api.me.mockResolvedValue({ themePrefs: account({ theme: "blue" }) });
    mount();
    await waitFor(() => expect(theme.theme).toBe("blue"));

    h.api.me.mockResolvedValue({
      themePrefs: account({ theme: "teal-dark", customColors: ["#ff0000"], customActive: true }),
    });
    await refocus();
    await waitFor(() => expect(theme.theme).toBe("teal-dark"));
    expect(theme.customThemeActive).toBe(true);
    expect(theme.customTheme).toEqual({ colors: ["#ff0000"] });
    expect(h.api.updateProfile).not.toHaveBeenCalled();
  });

  it("does not re-read on every focus event in a burst", async () => {
    h.api.me.mockResolvedValue({ themePrefs: account() });
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(h.api.me).toHaveBeenCalledTimes(1);
  });
});

describe("races", () => {
  it("discards a read that a local change overtook, instead of snapping the choice back", async () => {
    let answer!: (v: unknown) => void;
    h.api.me.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    mount();
    await waitFor(() => expect(h.api.me).toHaveBeenCalled());

    act(() => theme.setTheme("purple")); // picked while the read is still in flight
    await act(async () => answer({ themePrefs: account({ theme: "rose" }) })); // the OLD account copy

    expect(theme.theme).toBe("purple");
  });

  it("re-sends after a failed push rather than adopting the older account copy", async () => {
    h.api.me.mockResolvedValue({ themePrefs: account({ theme: "blue" }) });
    mount();
    await waitFor(() => expect(theme.theme).toBe("blue"));

    h.api.updateProfile.mockRejectedValueOnce(new Error("offline"));
    act(() => theme.setTheme("rose"));
    await waitFor(() => expect(h.api.updateProfile).toHaveBeenCalledTimes(1));

    await refocus(); // account still says "blue"
    await waitFor(() => expect(h.api.updateProfile).toHaveBeenCalledTimes(2));
    expect(h.api.updateProfile).toHaveBeenLastCalledWith({
      themePrefs: { theme: "rose", customColors: null, customActive: false },
    });
    expect(theme.theme).toBe("rose");
  });
});

describe("a push that fails", () => {
  beforeEach(() => h.api.me.mockResolvedValue({ themePrefs: account({ theme: "blue" }) }));

  it("tells the person the change is on this device only, once, without stacking", async () => {
    mount();
    await waitFor(() => expect(theme.theme).toBe("blue"));
    h.api.updateProfile.mockRejectedValue(new Error("offline"));
    act(() => theme.setTheme("rose"));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    expect(h.toastError.mock.calls[0]![0]).toMatch(/this device/i);
    expect(h.toastError.mock.calls[0]![1]).toMatchObject({ id: "theme-sync-failed" });
    expect(theme.theme).toBe("rose"); // the local change still applies
  });

  it("stays silent when the background retry fails again", async () => {
    mount();
    await waitFor(() => expect(theme.theme).toBe("blue"));
    h.api.updateProfile.mockRejectedValue(new Error("offline"));
    act(() => theme.setTheme("rose"));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    await refocus();
    await waitFor(() => expect(h.api.updateProfile).toHaveBeenCalledTimes(2));
    expect(h.toastError).toHaveBeenCalledTimes(1);
  });

  it("is still re-sent after a reload instead of the older account copy winning", async () => {
    const first = mount();
    await waitFor(() => expect(theme.theme).toBe("blue"));
    h.api.updateProfile.mockRejectedValueOnce(new Error("offline"));
    act(() => theme.setTheme("rose"));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    first.unmount(); // "reload": the in-memory state is gone, localStorage is not

    mount(); // the account still says "blue"
    await waitFor(() =>
      expect(h.api.updateProfile).toHaveBeenLastCalledWith({
        themePrefs: { theme: "rose", customColors: null, customActive: false },
      }),
    );
    expect(theme.theme).toBe("rose");
  });

  it("does not carry one account's unsent change into another account", async () => {
    const first = mount();
    await waitFor(() => expect(theme.theme).toBe("blue"));
    h.api.updateProfile.mockRejectedValueOnce(new Error("offline"));
    act(() => theme.setTheme("rose"));
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    first.unmount();

    useSession.setState({ user: { id: "someone-else" } as UserDTO });
    h.api.me.mockResolvedValue({ themePrefs: account({ theme: "teal" }) });
    h.api.updateProfile.mockClear();
    mount();
    await waitFor(() => expect(theme.theme).toBe("teal")); // adopts THEIR copy
    expect(h.api.updateProfile).not.toHaveBeenCalled();
  });

  it("does not push another account's theme back into the first account when they return", async () => {
    const first = mount();
    await waitFor(() => expect(theme.theme).toBe("blue"));
    h.api.updateProfile.mockRejectedValueOnce(new Error("offline"));
    act(() => theme.setTheme("rose")); // u1's change, never sent
    await waitFor(() => expect(h.toastError).toHaveBeenCalled());
    first.unmount();

    useSession.setState({ user: { id: "someone-else" } as UserDTO });
    h.api.me.mockResolvedValue({ themePrefs: account({ theme: "teal" }) });
    const second = mount();
    await waitFor(() => expect(theme.theme).toBe("teal"));
    second.unmount();

    // u1 signs back in. This device now shows someone else's "teal"; u1's own
    // unsent "rose" is gone from it, so it must not be "re-sent" — least of all
    // as teal. The account's own copy is what u1 gets.
    useSession.setState({ user: { id: "u1" } as UserDTO });
    h.api.me.mockResolvedValue({ themePrefs: account({ theme: "blue" }) });
    h.api.updateProfile.mockClear();
    mount();
    await waitFor(() => expect(theme.theme).toBe("blue"));
    expect(h.api.updateProfile).not.toHaveBeenCalled();
  });

  it("gives up on a change the server refuses (4xx) rather than resending it forever", async () => {
    mount();
    await waitFor(() => expect(theme.theme).toBe("blue"));
    h.api.updateProfile.mockRejectedValueOnce(new ApiError(422, "bad theme"));
    act(() => theme.setTheme("rose"));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));

    h.api.me.mockResolvedValue({ themePrefs: account({ theme: "teal" }) });
    await refocus();
    await waitFor(() => expect(theme.theme).toBe("teal")); // back in step with the account
    expect(h.api.updateProfile).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying a transient server error (5xx)", async () => {
    mount();
    await waitFor(() => expect(theme.theme).toBe("blue"));
    h.api.updateProfile.mockRejectedValueOnce(new ApiError(503, "unavailable"));
    act(() => theme.setTheme("rose"));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledTimes(1));
    await refocus();
    await waitFor(() => expect(h.api.updateProfile).toHaveBeenCalledTimes(2));
    expect(theme.theme).toBe("rose");
  });
});
