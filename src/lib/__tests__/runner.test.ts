import { describe, it, expect } from "bun:test";
import {
  getDescendantPids,
  hasTaskRunTimedOut,
  parseSessionIdFromJsonOutput,
} from "../runner.js";

describe("parseSessionIdFromJsonOutput", () => {
  it("extracts session ID from session.created event", () => {
    const output = `{"type":"session.created","properties":{"info":{"id":"ses_abc123def456"}}}
{"type":"message.updated","properties":{}}`;

    expect(parseSessionIdFromJsonOutput(output)).toBe("ses_abc123def456");
  });

  it("extracts session ID from sessionID field", () => {
    const output = `{"sessionID":"ses_xyz789"}`;
    expect(parseSessionIdFromJsonOutput(output)).toBe("ses_xyz789");
  });

  it("extracts session ID from properties.sessionID", () => {
    const output = `{"type":"something","properties":{"sessionID":"ses_qrs456"}}`;
    expect(parseSessionIdFromJsonOutput(output)).toBe("ses_qrs456");
  });

  it("returns undefined for output without session ID", () => {
    const output = `{"type":"message.updated","properties":{}}
some non-json output`;
    expect(parseSessionIdFromJsonOutput(output)).toBeUndefined();
  });

  it("returns undefined for empty output", () => {
    expect(parseSessionIdFromJsonOutput("")).toBeUndefined();
  });

  it("handles mixed JSON and non-JSON lines", () => {
    const output = `Starting opencode...
{"type":"session.created","properties":{"info":{"id":"ses_found"}}}
Done.`;
    expect(parseSessionIdFromJsonOutput(output)).toBe("ses_found");
  });
});

describe("hasTaskRunTimedOut", () => {
  it("detects runs older than their configured timeout", () => {
    expect(
      hasTaskRunTimedOut(
        "2026-08-12T10:00:00.000Z",
        60 * 60 * 1000,
        new Date("2026-08-12T11:00:00.001Z")
      )
    ).toBe(true);
  });

  it("allows runs at the timeout boundary", () => {
    expect(
      hasTaskRunTimedOut(
        "2026-08-12T10:00:00.000Z",
        60 * 60 * 1000,
        new Date("2026-08-12T11:00:00.000Z")
      )
    ).toBe(false);
  });
});

describe("getDescendantPids", () => {
  it("returns descendants deepest-first", () => {
    const processTable = `
100 1
110 100
120 100
111 110
200 1
`;

    expect(getDescendantPids(100, processTable)).toEqual([111, 110, 120]);
  });
});
