import { afterEach, describe, expect, it } from "vitest";
import type { CallDTO } from "@taskboard/shared";
import i18n from "../i18n";
import { durationLabel, joinNames, meetingKindLabel, meetingScope, meetingTitle, statusLabel } from "./meetingView";

const call = (over: Partial<CallDTO>) => ({ title: "", createdBy: "u1", kind: "MEETING", status: "SCHEDULED", ...over }) as CallDTO;

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("meetingView text (English, unchanged)", () => {
  it("joins names exactly as before", () => {
    expect(joinNames([])).toBe("Untitled meeting");
    expect(joinNames(["Alice"])).toBe("Alice");
    expect(joinNames(["Alice", "Bob"])).toBe("Alice & Bob");
    expect(joinNames(["Alice", "Bob", "Carol"])).toBe("Alice, Bob & Carol");
    expect(joinNames(["A", "B", "C", "D"])).toBe("A, B & 2 others");
    expect(joinNames(["A", "B", "C", "D", "E", "F"])).toBe("A, B & 4 others");
  });

  it("labels kinds, scopes, titles and statuses", () => {
    expect(meetingKindLabel("CHANNEL")).toBe("Channel calls");
    expect(meetingScope(call({ kind: "DIRECT" }))).toBe("Direct call");
    expect(meetingScope(call({ kind: "MEETING" }))).toBeNull();
    expect(meetingTitle(call({}), () => "")).toBe("Untitled meeting");
    expect(statusLabel(call({ status: "CANCELLED" }))).toBe("Cancelled");
    expect(statusLabel(call({ status: "ENDED" }))).toBe("Ended");
  });

  it("formats durations as before", () => {
    expect(durationLabel(null)).toBe("—");
    expect(durationLabel(30_000)).toBe("<1m");
    expect(durationLabel(45 * 60_000)).toBe("45m");
    expect(durationLabel(80 * 60_000)).toBe("1h 20m");
    expect(durationLabel(120 * 60_000)).toBe("2h");
  });
});

describe("meetingView text follows the active language", () => {
  it("uses the locale's catalog and separator, and its plural form", async () => {
    i18n.addResourceBundle(
      "ja",
      "meetings",
      {
        view: {
          untitled: "無題",
          listSeparator: "、",
          namesAnd: "{{list}}と{{last}}",
          namesAndOthers_other: "{{list}}ほか{{count}}名",
          status: { live: "ライブ" },
        },
      },
      true,
      true,
    );
    await i18n.changeLanguage("ja");
    expect(joinNames([])).toBe("無題");
    expect(joinNames(["A", "B", "C"])).toBe("A、BとC");
    expect(joinNames(["A", "B", "C", "D", "E"])).toBe("A、Bほか3名");
    expect(statusLabel(call({ status: "LIVE" }))).toBe("ライブ");
  });

  it("formats compact durations with the language's unit", async () => {
    await i18n.changeLanguage("zh");
    expect(durationLabel(80 * 60_000)).toBe("1小时 20分钟");
    await i18n.changeLanguage("de");
    expect(durationLabel(45 * 60_000)).toMatch(/^45\s?Min\.?$/);
  });
});
