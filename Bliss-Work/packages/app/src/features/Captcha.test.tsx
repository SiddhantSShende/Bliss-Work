/**
 * The CAPTCHA field: the answer is typed exactly (case matters), a refresh
 * discards the old challenge on the server, and the control is usable by
 * keyboard and screen reader. Real component and real i18n; only the runtime's
 * network client is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({ api: { getCaptcha: vi.fn() } }));
vi.mock("../lib/runtime", () => ({ useRuntime: () => ({ api: h.api, config: {} }) }));

import { CaptchaField, useCaptcha } from "./Captcha";

function Harness() {
  const captcha = useCaptcha();
  return <CaptchaField captcha={captcha} />;
}

const challenge = (n: number) => ({
  captchaId: `cap-${n}`,
  captchaImage: `data:image/png;base64,IMG${n}`,
  expiresIn: 300,
});

beforeEach(() => {
  h.api.getCaptcha.mockReset();
  h.api.getCaptcha.mockResolvedValueOnce(challenge(1)).mockResolvedValueOnce(challenge(2)).mockResolvedValue(challenge(3));
});

describe("refreshing", () => {
  it("asks for the first challenge without a previous id, then names the one it is replacing", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByRole("img", { name: /captcha/i });
    expect(h.api.getCaptcha).toHaveBeenNthCalledWith(1, undefined);

    await user.click(screen.getByRole("button", { name: "Refresh security check" }));
    await waitFor(() => expect(h.api.getCaptcha).toHaveBeenCalledTimes(2));
    expect(h.api.getCaptcha).toHaveBeenNthCalledWith(2, "cap-1");

    await waitFor(() => expect(screen.getByRole("img", { name: /captcha/i })).toHaveAttribute("src", expect.stringContaining("IMG2")));
    await user.click(screen.getByRole("button", { name: "Refresh security check" }));
    await waitFor(() => expect(h.api.getCaptcha).toHaveBeenCalledTimes(3));
    expect(h.api.getCaptcha).toHaveBeenNthCalledWith(3, "cap-2");
  });

  it("clears what was typed, because the answer belonged to the old image", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = await screen.findByLabelText("CAPTCHA answer");
    await user.type(input, "AbDe");
    await user.click(screen.getByRole("button", { name: "Refresh security check" }));
    await waitFor(() => expect(h.api.getCaptcha).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText("CAPTCHA answer")).toHaveValue(""));
  });

  it("is not triggered by clicking the label text or the image", async () => {
    // The field used to be one <label>; its activation behaviour clicked the
    // first labelable descendant — the refresh button — and wiped the answer.
    const user = userEvent.setup();
    render(<Harness />);
    const image = await screen.findByRole("img", { name: /captcha/i });
    await user.type(screen.getByLabelText("CAPTCHA answer"), "Ab");

    await user.click(screen.getByText("Security check"));
    await user.click(image);

    expect(h.api.getCaptcha).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("CAPTCHA answer")).toHaveValue("Ab");
  });
});

describe("the answer", () => {
  it("keeps exactly the case that was typed", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = await screen.findByLabelText("CAPTCHA answer");
    await user.type(input, "aBdEhQ3");
    expect(input).toHaveValue("aBdEhQ3");
  });

  it("asks the keyboard not to capitalise, correct or suggest", async () => {
    render(<Harness />);
    const input = await screen.findByLabelText("CAPTCHA answer");
    expect(input).toHaveAttribute("autocapitalize", "off");
    expect(input).toHaveAttribute("autocorrect", "off");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("autocomplete", "off");
  });

  it("tells people that case matters, and ties that to the input", async () => {
    render(<Harness />);
    const input = await screen.findByLabelText("CAPTCHA answer");
    const hint = screen.getByText("Upper and lower case letters are different.");
    expect(input).toHaveAccessibleDescription("Upper and lower case letters are different.");
    expect(hint).toBeVisible();
  });
});

describe("accessibility", () => {
  it("names the group, the image, the input and the refresh control", async () => {
    render(<Harness />);
    await screen.findByRole("img", { name: /captcha/i });
    expect(screen.getByRole("group", { name: "Security check" })).toBeInTheDocument();
    expect(screen.getByLabelText("CAPTCHA answer")).toBeRequired();
    expect(screen.getByRole("button", { name: "Refresh security check" })).toHaveAttribute("type", "button");
  });

  it("can be refreshed from the keyboard", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await screen.findByRole("img", { name: /captcha/i });
    const refresh = screen.getByRole("button", { name: "Refresh security check" });

    await user.tab(); // image is not focusable; the first stop is the refresh button
    expect(refresh).toHaveFocus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(h.api.getCaptcha).toHaveBeenCalledTimes(2));

    await waitFor(() => expect(refresh).toBeEnabled());
    refresh.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(h.api.getCaptcha).toHaveBeenCalledTimes(3));
  });
});

describe("the image", () => {
  it("is shown whole at its own proportions, never cropped to a fixed small box", async () => {
    render(<Harness />);
    const image = await screen.findByRole("img", { name: /captcha/i });
    expect(image).toHaveClass("object-contain");
    expect(image).not.toHaveClass("object-cover");
    const box = image.parentElement!;
    expect(box.className).toContain("aspect-[300/90]");
    expect(box.className).not.toMatch(/\bh-\[52px\]/);
  });
});
