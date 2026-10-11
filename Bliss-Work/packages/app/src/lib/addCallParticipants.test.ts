import { describe, expect, it, vi } from "vitest";
import { addCallParticipants } from "./addCallParticipants";

describe("addCallParticipants", () => {
  it("adds everyone, one request each and in order", async () => {
    const seen: string[] = [];
    const add = vi.fn(async (id: string) => void seen.push(id));

    const out = await addCallParticipants(add, ["c", "d", "e"]);

    expect(seen).toEqual(["c", "d", "e"]);
    expect(out).toEqual({ added: ["c", "d", "e"], failed: [] });
  });

  it("keeps going past a refusal — the people already added are on their way", async () => {
    const refusal = new Error("forbidden");
    const add = vi.fn(async (id: string) => {
      if (id === "d") throw refusal;
    });

    const out = await addCallParticipants(add, ["c", "d", "e"]);

    expect(add).toHaveBeenCalledTimes(3);
    expect(out.added).toEqual(["c", "e"]);
    expect(out.failed).toEqual([{ userId: "d", error: refusal }]);
  });

  it("does not run requests in parallel: the server checks each against the call as it then stands", async () => {
    let inFlight = 0;
    let peak = 0;
    const add = async () => {
      peak = Math.max(peak, ++inFlight);
      await Promise.resolve();
      inFlight--;
    };
    await addCallParticipants(add, ["c", "d", "e", "f"]);
    expect(peak).toBe(1);
  });

  it("reports everyone as failed when the call is full", async () => {
    const full = new Error("call has reached its participant limit");
    const out = await addCallParticipants(async () => Promise.reject(full), ["c", "d"]);
    expect(out.added).toEqual([]);
    expect(out.failed.map((f) => f.userId)).toEqual(["c", "d"]);
  });
});
