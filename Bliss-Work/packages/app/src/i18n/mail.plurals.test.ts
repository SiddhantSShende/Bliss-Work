import { afterEach, describe, expect, it } from "vitest";
import i18n from "./index";
import { ensureLocaleLoaded } from "./catalogs";

// These replaced "{n} {singular|plural noun}" string concatenation in MailList and
// MailDraftList: the count and its noun are now ONE translated string, so word
// order, counters (件 / 个 / 개) and plural forms belong to the language.
afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("mail count strings", () => {
  it("English: singular, plural, and the paging '+' case", () => {
    expect(i18n.t("mail:list.messageCount", { count: 1, shown: "1" })).toBe("1 message");
    expect(i18n.t("mail:list.messageCount", { count: 7, shown: "7" })).toBe("7 messages");
    // one row on a feed that still has more pages is plural ("1+ messages")
    expect(i18n.t("mail:list.messageCount", { count: 2, shown: "1+" })).toBe("1+ messages");
    expect(i18n.t("mail:draftList.attachments", { count: 1 })).toBe("1 file");
    expect(i18n.t("mail:draftList.attachments", { count: 3 })).toBe("3 files");
  });

  it.each([
    ["ja", "5件", "5件のファイル"],
    ["zh", "5 条消息", "5 个文件"],
    ["ko", "메시지 5개", "파일 5개"],
  ])("%s: the number sits inside the string with the language's own counter", async (code, messages, files) => {
    await ensureLocaleLoaded(i18n, code);
    await i18n.changeLanguage(code);
    expect(i18n.t("mail:list.messageCount", { count: 5, shown: "5" })).toBe(messages);
    expect(i18n.t("mail:draftList.attachments", { count: 5 })).toBe(files);
    // CJK has one plural form: 1 and 5 use the same string
    expect(i18n.t("mail:draftList.attachments", { count: 1 })).toBe(files.replace("5", "1"));
  });

  it("Spanish uses three plural forms", async () => {
    await ensureLocaleLoaded(i18n, "es");
    await i18n.changeLanguage("es");
    expect(i18n.t("mail:draftList.attachments", { count: 1 })).toBe("1 archivo");
    expect(i18n.t("mail:draftList.attachments", { count: 3 })).toBe("3 archivos");
    expect(i18n.t("mail:draftList.attachments", { count: 1_000_000 })).toBe("1000000 de archivos");
  });
});
