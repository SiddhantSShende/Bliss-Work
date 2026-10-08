import { afterEach, describe, expect, it } from "vitest";
import i18n from "./index";
import { formatDurationCompact, formatMs } from "./format";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("formatDurationCompact", () => {
  it("matches the long-standing English output", () => {
    expect(formatDurationCompact(0)).toBe("<1m");
    expect(formatDurationCompact(59_999)).toBe("<1m");
    expect(formatDurationCompact(60_000)).toBe("1m");
    expect(formatDurationCompact(3_600_000)).toBe("1h");
    expect(formatDurationCompact(5_400_000)).toBe("1h 30m");
  });
});

describe("formatMs (chart/stat durations)", () => {
  it("keeps the English m/h format", () => {
    expect(formatMs(0)).toBe("0");
    expect(formatMs(45 * 60_000)).toBe("45m");
    expect(formatMs(90 * 60_000)).toBe("1.5h");
    expect(formatMs(120 * 60_000)).toBe("2h");
    expect(formatMs(12 * 3_600_000)).toBe("12h");
  });

  it("follows the in-app language, not the browser's", async () => {
    await i18n.changeLanguage("ja");
    expect(formatMs(45 * 60_000)).toMatch(/45/);
    expect(formatMs(45 * 60_000)).not.toBe("45m".replace("m", "x"));
    await i18n.changeLanguage("zh");
    expect(formatMs(90 * 60_000)).toBe("1.5小时");
  });
});
