import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PageHeader } from "@taskboard/ui";
import i18n from "./index";
import { UiStringsBridge } from "./UiStringsBridge";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("UiStringsBridge", () => {
  it("gives @taskboard/ui's default labels in English", () => {
    render(
      <UiStringsBridge>
        <PageHeader title="x" onBack={() => {}} />
      </UiStringsBridge>,
    );
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
  });

  it("translates them with the active language", async () => {
    i18n.addResourceBundle("ja", "common", { ui: { back: "戻る" } }, true, true);
    await i18n.changeLanguage("ja");
    render(
      <UiStringsBridge>
        <PageHeader title="x" onBack={() => {}} />
      </UiStringsBridge>,
    );
    expect(screen.getByRole("button", { name: "戻る" })).toBeInTheDocument();
  });

  it("an explicit backLabel still wins", () => {
    render(
      <UiStringsBridge>
        <PageHeader title="x" onBack={() => {}} backLabel="Close" />
      </UiStringsBridge>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
