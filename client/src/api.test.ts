import { afterEach, describe, expect, it, vi } from "vitest";
import { dialogPickNewProject, dialogPickProject } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return body;
      },
    })),
  );
}

describe("dialogPickProject", () => {
  it("returns ok with the chosen path", async () => {
    mockFetch(200, { path: "/Users/me/notes.bwbk" });
    const result = await dialogPickProject();
    expect(result).toEqual({ status: "ok", path: "/Users/me/notes.bwbk" });
  });

  it("returns ok with null when the user cancels", async () => {
    mockFetch(200, { path: null });
    const result = await dialogPickProject();
    expect(result).toEqual({ status: "ok", path: null });
  });

  it("returns unavailable on 501 and forwards the server's detail", async () => {
    mockFetch(501, {
      detail: "Native file dialog is only implemented on macOS.",
    });
    const result = await dialogPickProject();
    expect(result).toEqual({
      status: "unavailable",
      reason: "Native file dialog is only implemented on macOS.",
    });
  });

  it("falls back to a generic reason when the 501 body has no detail", async () => {
    mockFetch(501, {});
    const result = await dialogPickProject();
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("throws on other error statuses", async () => {
    mockFetch(500, { detail: "internal error" });
    await expect(dialogPickProject()).rejects.toThrow("internal error");
  });
});

describe("dialogPickNewProject", () => {
  it("returns ok with the chosen path", async () => {
    mockFetch(200, { path: "/Users/me/new.bwbk" });
    const result = await dialogPickNewProject();
    expect(result).toEqual({ status: "ok", path: "/Users/me/new.bwbk" });
  });

  it("returns unavailable on 501", async () => {
    mockFetch(501, { detail: "platform mismatch" });
    const result = await dialogPickNewProject();
    expect(result).toEqual({ status: "unavailable", reason: "platform mismatch" });
  });
});
