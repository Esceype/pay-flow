import { describe, expect, it } from "vitest";
import { clientAddress, RATE_LIMITS } from "./rate-limit";

describe("clientAddress", () => {
  it("uses the left-most X-Forwarded-For entry — the original client", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.2, 10.0.0.1" });
    expect(clientAddress(headers)).toBe("203.0.113.7");
  });

  it("trims whitespace around the address", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "  203.0.113.7  " }))).toBe(
      "203.0.113.7"
    );
  });

  it("falls back to X-Real-IP", () => {
    expect(clientAddress(new Headers({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("puts clients it can't identify into one shared bucket", () => {
    expect(clientAddress(new Headers())).toBe("unknown");
    expect(clientAddress(new Headers({ "x-forwarded-for": "" }))).toBe("unknown");
  });
});

describe("RATE_LIMITS", () => {
  it("gives every rule a distinct key namespace", () => {
    const names = Object.values(RATE_LIMITS).map((rule) => rule.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
