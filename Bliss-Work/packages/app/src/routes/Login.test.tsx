/**
 * Login's CAPTCHA follows the platform: macOS (browser and Electron app) and iOS
 * sign in without one; Windows, Linux, Android and anything unrecognised keep it.
 *
 * Runs the real Login and the real platform detector — only the network-facing
 * runtime, the toast and the cross-tab channel are stubbed — so each case goes
 * from a user-agent string all the way to the payload /auth/login receives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ApiError } from "@taskboard/shared";
import { UA } from "../test/userAgents";

const h = vi.hoisted(() => ({
  api: { getCaptcha: vi.fn(), login: vi.fn() },
  toastError: vi.fn(),
}));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));
vi.mock("../lib/authChannel", () => ({ broadcastSession: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: h.toastError, success: vi.fn() } }));

import { Login } from "./Login";

const SESSION = {
  user: { id: "u1", orgId: "o1", username: "sam", displayName: "Sam", roles: ["member"] },
  accessToken: "token",
  expiresIn: 900,
};

function renderLogin() {
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/app" element={<div>signed in</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const emailInput = () => screen.getByPlaceholderText("you@acme.com");
const passwordInput = () => screen.getByPlaceholderText("••••••••");
const captchaInput = () => screen.queryByLabelText("CAPTCHA answer");
const submitButton = () => screen.getByRole("button", { name: "Sign in" });

async function fillCredentials(user: ReturnType<typeof userEvent.setup>) {
  await user.type(emailInput(), "sam@example.com");
  await user.type(passwordInput(), "correct-horse-9");
}

beforeEach(() => {
  h.api.getCaptcha.mockReset();
  h.api.getCaptcha.mockResolvedValue({
    captchaId: "cap-1",
    captchaImage: "data:image/png;base64,AAAA",
    expiresIn: 300,
  });
  h.api.login.mockReset();
  h.api.login.mockResolvedValue(SESSION);
  h.toastError.mockReset();
});
afterEach(() => vi.restoreAllMocks());

const asPlatform = (ua: string) => vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);

describe("Login on platforms that are not challenged", () => {
  it.each([
    ["macOS browser", UA.macBrowser, "macos"],
    ["macOS Electron app", UA.macElectron, "macos"],
    ["iOS", UA.iphone, "ios"],
  ])("%s: no CAPTCHA is fetched, shown, or waited on", async (_label, ua, platform) => {
    asPlatform(ua);
    const user = userEvent.setup();
    renderLogin();
    await fillCredentials(user);

    expect(captchaInput()).toBeNull();
    expect(submitButton()).toBeEnabled();

    await user.click(submitButton());

    await waitFor(() => expect(h.api.login).toHaveBeenCalledOnce());
    expect(h.api.login).toHaveBeenCalledWith({
      email: "sam@example.com",
      password: "correct-horse-9",
      clientPlatform: platform,
    });
    expect(h.api.getCaptcha).not.toHaveBeenCalled();
    expect(await screen.findByText("signed in")).toBeInTheDocument();
  });
});

describe("Login on platforms that keep the CAPTCHA", () => {
  it.each([
    ["Windows", UA.windows, "windows"],
    ["Windows Electron app", UA.windowsElectron, "windows"],
    ["Linux", UA.linux, "linux"],
    ["Android", UA.android, "android"],
    ["an unrecognised client", UA.unknown, "unknown"],
  ])("%s: shows the CAPTCHA and sends its answer", async (_label, ua, platform) => {
    asPlatform(ua);
    const user = userEvent.setup();
    renderLogin();
    await fillCredentials(user);

    const answer = await screen.findByLabelText("CAPTCHA answer");
    expect(h.api.getCaptcha).toHaveBeenCalledOnce();
    // Still blocks sign-in until the challenge has been answered.
    expect(submitButton()).toBeDisabled();

    await user.type(answer, "AbCdEf");
    expect(submitButton()).toBeEnabled();
    await user.click(submitButton());

    await waitFor(() => expect(h.api.login).toHaveBeenCalledOnce());
    expect(h.api.login).toHaveBeenCalledWith({
      email: "sam@example.com",
      password: "correct-horse-9",
      clientPlatform: platform,
      captchaId: "cap-1",
      captchaValue: "AbCdEf",
    });
  });

  it("does not send a login until the CAPTCHA has loaded", async () => {
    asPlatform(UA.windows);
    h.api.getCaptcha.mockRejectedValue(new Error("offline"));
    const user = userEvent.setup();
    renderLogin();
    await fillCredentials(user);

    await waitFor(() => expect(h.api.getCaptcha).toHaveBeenCalled());
    expect(submitButton()).toBeDisabled();
    expect(h.api.login).not.toHaveBeenCalled();
  });
});

describe("Login when the server wants a CAPTCHA the client skipped", () => {
  it("falls back to showing the challenge instead of a dead end", async () => {
    asPlatform(UA.macBrowser);
    h.api.login.mockRejectedValueOnce(new ApiError(400, "invalid or expired captcha"));
    const user = userEvent.setup();
    renderLogin();
    await fillCredentials(user);

    await user.click(submitButton());

    expect(await screen.findByLabelText("CAPTCHA answer")).toBeInTheDocument();
    expect(h.api.getCaptcha).toHaveBeenCalledOnce();
    expect(h.toastError).toHaveBeenCalledWith("Security check required", expect.anything());

    // …and the retry now carries the answer.
    await user.type(screen.getByLabelText("CAPTCHA answer"), "AbCdEf");
    await user.click(submitButton());
    await waitFor(() => expect(h.api.login).toHaveBeenCalledTimes(2));
    expect(h.api.login).toHaveBeenLastCalledWith({
      email: "sam@example.com",
      password: "correct-horse-9",
      clientPlatform: "macos",
      captchaId: "cap-1",
      captchaValue: "AbCdEf",
    });
  });
});
