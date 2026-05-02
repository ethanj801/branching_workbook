import { describe, it, expect } from "vitest";
import { contextHash } from "./hash";

describe("contextHash", () => {
  it("is deterministic", () => {
    expect(contextHash("hello")).toBe(contextHash("hello"));
    expect(contextHash("")).toBe(contextHash(""));
  });

  it("differs on different inputs", () => {
    expect(contextHash("hello")).not.toBe(contextHash("hellp"));
    expect(contextHash("a")).not.toBe(contextHash("b"));
  });

  it("returns a 16-char lowercase hex string", () => {
    expect(contextHash("")).toMatch(/^[0-9a-f]{16}$/);
    expect(contextHash("a longer piece of text with spaces")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is whitespace-sensitive (matters for prefix-hash equality)", () => {
    expect(contextHash("hello")).not.toBe(contextHash("hello "));
    expect(contextHash("hello\n")).not.toBe(contextHash("hello"));
  });
});
