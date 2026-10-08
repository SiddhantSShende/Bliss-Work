import { afterEach, describe, expect, it } from "vitest";
import i18n from "../i18n";
import { listTime } from "./mailView";

// Regression: listTime compared dayLabel()'s TRANSLATED result with the English
// literal "Today", so outside English the mail list printed the word instead of
// the clock.
describe("listTime in a non-English locale", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("shows the clock, not the word for today, for a message received today", async () => {
    i18n.addResourceBundle("ja", "common", { date: { today: "今日", yesterday: "昨日" } }, true, true);
    await i18n.changeLanguage("ja");
    const out = listTime(new Date().toISOString());
    expect(out).not.toBe("今日");
    expect(out).toMatch(/\d/);
  });

  it("still shows the day label for an older message", async () => {
    i18n.addResourceBundle("ja", "common", { date: { today: "今日", yesterday: "昨日" } }, true, true);
    await i18n.changeLanguage("ja");
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect(listTime(yesterday)).toBe("昨日");
  });

  it("is unchanged in English", () => {
    expect(listTime(new Date().toISOString())).toMatch(/\d/);
    expect(listTime(new Date(Date.now() - 86_400_000).toISOString())).toBe("Yesterday");
  });
});
