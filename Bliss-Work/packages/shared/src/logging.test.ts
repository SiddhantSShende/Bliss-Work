import { afterEach, describe, expect, it, vi } from "vitest";
import { getLogLevel, logger, setLogLevel } from "./logging";

const initialLevel = getLogLevel();

afterEach(() => {
  setLogLevel(initialLevel);
  vi.restoreAllMocks();
});

describe("application logging policy", () => {
  it("suppresses routine output at warning level but preserves warnings and errors", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setLogLevel("warn");

    logger.debug("state transition");
    logger.info("request completed");
    logger.warn("contract mismatch");
    logger.error("request failed");

    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("contract mismatch");
    expect(error).toHaveBeenCalledWith("request failed");
  });

  it("redacts credentials, identifiers, personal data, and payload fields", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setLogLevel("error");
    logger.error(
      "Request failed for jane.doe@example.test with Bearer abc.def and session 123e4567-e89b-42d3-a456-426614174000",
      new Error('refreshToken=refresh-secret {"message":"private chat content"} at https://internal.example.test/api'),
      {
        accessToken: "access-secret",
        sessionId: "session-secret",
        requestId: "request-secret",
        userEmail: "jane.doe@example.test",
        senderId: "sender-secret",
        callId: "123e4567-e89b-42d3-a456-426614174000",
        body: { message: "private chat content" },
        status: 502,
      },
    );

    const output = JSON.stringify(error.mock.calls);
    for (const privateValue of [
      "jane.doe@example.test",
      "abc.def",
      "123e4567-e89b-42d3-a456-426614174000",
      "refresh-secret",
      "access-secret",
      "session-secret",
      "request-secret",
      "sender-secret",
      "private chat content",
      "https://internal.example.test/api",
    ]) {
      expect(output).not.toContain(privateValue);
    }
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("502");
  });
});
