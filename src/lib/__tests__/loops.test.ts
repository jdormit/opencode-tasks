import { describe, it, expect } from "bun:test";
import {
  parseLoopArgs,
  intervalToCron,
  msUntilNextCronTick,
  defaultExpiry,
  isExpired,
  formatLoopConfirmation,
  formatLoopStopped,
  formatLoopList,
  DEFAULT_INTERVAL_LABEL,
  LoopArgError,
} from "../loops.js";
import type { SessionLoop } from "../types.js";

function makeLoop(overrides: Partial<SessionLoop> = {}): SessionLoop {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    sessionId: "ses_abc",
    prompt: "check the deploy",
    schedule: "*/5 * * * *",
    intervalLabel: "5m",
    cwd: "/tmp",
    enabled: true,
    createdAt: "2026-05-15T12:00:00.000Z",
    ...overrides,
  };
}

describe("parseLoopArgs", () => {
  it("returns defaults for empty input", () => {
    const a = parseLoopArgs("");
    expect(a.intervalLabel).toBe(DEFAULT_INTERVAL_LABEL);
    expect(a.prompt).toBe("");
    expect(a.intervalOmitted).toBe(true);
    expect(a.promptOmitted).toBe(true);
  });

  it("treats a lone interval token as interval only", () => {
    const a = parseLoopArgs("15m");
    expect(a.intervalLabel).toBe("15m");
    expect(a.prompt).toBe("");
    expect(a.intervalOmitted).toBe(false);
    expect(a.promptOmitted).toBe(true);
  });

  it("treats a lone non-interval token as a prompt", () => {
    const a = parseLoopArgs("check");
    expect(a.intervalLabel).toBe(DEFAULT_INTERVAL_LABEL);
    expect(a.prompt).toBe("check");
    expect(a.intervalOmitted).toBe(true);
    expect(a.promptOmitted).toBe(false);
  });

  it("parses interval + prompt", () => {
    const a = parseLoopArgs("5m check the deploy");
    expect(a.intervalLabel).toBe("5m");
    expect(a.prompt).toBe("check the deploy");
    expect(a.intervalOmitted).toBe(false);
    expect(a.promptOmitted).toBe(false);
  });

  it("treats a multi-word prompt without leading interval as prompt only", () => {
    const a = parseLoopArgs("check the deploy");
    expect(a.intervalLabel).toBe(DEFAULT_INTERVAL_LABEL);
    expect(a.prompt).toBe("check the deploy");
    expect(a.intervalOmitted).toBe(true);
  });

  it("normalizes interval casing", () => {
    const a = parseLoopArgs("2H ping the cluster");
    expect(a.intervalLabel).toBe("2h");
    expect(a.prompt).toBe("ping the cluster");
  });

  it("trims surrounding whitespace", () => {
    const a = parseLoopArgs("   30m   say hi   ");
    expect(a.intervalLabel).toBe("30m");
    expect(a.prompt).toBe("say hi");
  });
});

describe("intervalToCron", () => {
  it("maps minute intervals", () => {
    const { cron, approxMinutes } = intervalToCron("5m");
    expect(cron).toBe("*/5 * * * *");
    expect(approxMinutes).toBe(5);
  });

  it("maps hour intervals", () => {
    const { cron, approxMinutes } = intervalToCron("2h");
    expect(cron).toBe("0 */2 * * *");
    expect(approxMinutes).toBe(120);
  });

  it("maps day intervals", () => {
    const { cron, approxMinutes } = intervalToCron("1d");
    expect(cron).toBe("0 0 */1 * *");
    expect(approxMinutes).toBe(60 * 24);
  });

  it("rejects sub-minute intervals", () => {
    expect(() => intervalToCron("30s")).toThrow(LoopArgError);
  });

  it("rejects invalid syntax", () => {
    expect(() => intervalToCron("blah")).toThrow(LoopArgError);
    expect(() => intervalToCron("5x")).toThrow(LoopArgError);
    expect(() => intervalToCron("-1m")).toThrow(LoopArgError);
  });

  it("rejects minute counts that should be hours", () => {
    expect(() => intervalToCron("90m")).toThrow(LoopArgError);
  });

  it("rejects hour counts that should be days", () => {
    expect(() => intervalToCron("48h")).toThrow(LoopArgError);
  });

  it("rejects day counts above 31", () => {
    expect(() => intervalToCron("60d")).toThrow(LoopArgError);
  });

  it("produces a cron that parses with cron-parser", () => {
    const { cron } = intervalToCron("5m");
    // Should not throw
    expect(msUntilNextCronTick(cron)).toBeGreaterThanOrEqual(0);
  });
});

describe("msUntilNextCronTick", () => {
  it("returns a non-negative number", () => {
    expect(msUntilNextCronTick("*/5 * * * *")).toBeGreaterThanOrEqual(0);
  });

  it("returns at most the interval duration for a recurring cron", () => {
    const ms = msUntilNextCronTick("*/5 * * * *");
    // Allow up to 5m + 1s of slop.
    expect(ms).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
  });
});

describe("defaultExpiry / isExpired", () => {
  it("default expiry is in the future", () => {
    const e = defaultExpiry();
    expect(new Date(e).getTime()).toBeGreaterThan(Date.now());
  });

  it("isExpired returns false when no expiry is set", () => {
    const loop = makeLoop({ expiresAt: undefined });
    expect(isExpired(loop)).toBe(false);
  });

  it("isExpired returns true for past expiry", () => {
    const loop = makeLoop({ expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(isExpired(loop)).toBe(true);
  });

  it("isExpired returns false for future expiry", () => {
    const loop = makeLoop({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(isExpired(loop)).toBe(false);
  });
});

describe("formatters", () => {
  it("confirmation includes id, cadence, prompt, stop hint", () => {
    const out = formatLoopConfirmation(makeLoop());
    expect(out).toContain("11111111-2222-3333-4444-555555555555");
    expect(out).toContain("every 5m");
    expect(out).toContain("check the deploy");
    expect(out).toMatch(/loop-stop/);
  });

  it("confirmation appends scheduler warning when provided", () => {
    const out = formatLoopConfirmation(makeLoop(), {
      schedulerWarning: "WARN ABOUT DAEMON",
    });
    expect(out).toContain("WARN ABOUT DAEMON");
  });

  it("stopped formatter handles empty / one / many", () => {
    expect(formatLoopStopped([])).toMatch(/No active loops/i);
    expect(formatLoopStopped([makeLoop()])).toMatch(/Stopped loop/i);
    expect(
      formatLoopStopped([
        makeLoop({ id: "a" }),
        makeLoop({ id: "b" }),
      ])
    ).toMatch(/Stopped 2 loops/);
  });

  it("list formatter handles empty / non-empty", () => {
    expect(formatLoopList([])).toMatch(/No active loops/i);
    const listing = formatLoopList([makeLoop()]);
    expect(listing).toContain("Active loops (1)");
    expect(listing).toContain("Cadence: every 5m");
  });
});
