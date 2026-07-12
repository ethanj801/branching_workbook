import { describe, expect, it } from "vitest";

import type { ProjectInfo } from "../api";
import type { Tree } from "../tree/types";
import {
  initialWorkspaceState,
  workspaceReducer,
  type WorkspaceState,
} from "./workspaceReducer";

const project: ProjectInfo = {
  path: "/tmp/demo.bwbk",
  title: "demo",
  created_at: null,
  version: "1",
  kind: "prose",
};

const treeA: Tree = { rootId: "root", nodes: {} };
const treeB: Tree = { rootId: "root", nodes: {} };

// A non-default state so each test can assert which fields move and which
// are left untouched.
const loaded: WorkspaceState = {
  project,
  tree: treeA,
  currentId: "n1",
  buffer: "hello",
  mapSelectedId: "n1",
  mapSelectionIds: ["n1"],
  mapLocateRequest: 3,
  streaming: false,
  saving: false,
  error: null,
};

describe("workspaceReducer — per-field setters", () => {
  it("setBuffer replaces the buffer and leaves everything else", () => {
    const next = workspaceReducer(loaded, { type: "setBuffer", value: "world" });
    expect(next.buffer).toBe("world");
    expect({ ...next, buffer: loaded.buffer }).toEqual(loaded);
  });

  it("setError accepts a plain value", () => {
    const next = workspaceReducer(loaded, { type: "setError", value: "boom" });
    expect(next.error).toBe("boom");
  });

  it("setError accepts a functional updater against the previous value", () => {
    const withError = { ...loaded, error: "GET /api/project/settings failed" };
    const cleared = workspaceReducer(withError, {
      type: "setError",
      value: (current) => (current?.includes("/api/project/settings") ? null : current),
    });
    expect(cleared.error).toBeNull();
  });

  it("setMapLocateRequest supports the bump updater", () => {
    const next = workspaceReducer(loaded, {
      type: "setMapLocateRequest",
      value: (v) => v + 1,
    });
    expect(next.mapLocateRequest).toBe(4);
  });

  it("setMapSelectionIds supports a functional updater", () => {
    const next = workspaceReducer(loaded, {
      type: "setMapSelectionIds",
      value: (current) => [...current, "n2"],
    });
    expect(next.mapSelectionIds).toEqual(["n1", "n2"]);
  });

  it("setSaving / setStreaming flip the flags", () => {
    expect(workspaceReducer(loaded, { type: "setSaving", value: true }).saving).toBe(
      true,
    );
    expect(
      workspaceReducer(loaded, { type: "setStreaming", value: true }).streaming,
    ).toBe(true);
  });
});

describe("workspaceReducer — semantic transitions", () => {
  it("projectLoaded sets the document cluster and preserves flags + map selection", () => {
    const next = workspaceReducer(initialWorkspaceState, {
      type: "projectLoaded",
      project,
      tree: treeA,
      currentId: "n1",
      buffer: "hello",
    });
    expect(next.project).toBe(project);
    expect(next.tree).toBe(treeA);
    expect(next.currentId).toBe("n1");
    expect(next.buffer).toBe("hello");
    // Map selection is not touched on load — the fallback effect reconciles it.
    expect(next.mapSelectedId).toBeNull();
    expect(next.mapSelectionIds).toEqual([]);
    expect(next.mapLocateRequest).toBe(0);
  });

  it("projectClosed clears the document cluster but leaves map + flags", () => {
    const next = workspaceReducer(loaded, { type: "projectClosed" });
    expect(next.project).toBeNull();
    expect(next.tree).toBeNull();
    expect(next.currentId).toBeNull();
    expect(next.buffer).toBe("");
    expect(next.mapSelectedId).toBe("n1");
    expect(next.mapSelectionIds).toEqual(["n1"]);
  });

  it("bufferReshaped / nodeSelected move tree+currentId+buffer only", () => {
    const reshaped = workspaceReducer(loaded, {
      type: "bufferReshaped",
      tree: treeB,
      currentId: "n2",
      buffer: "next",
    });
    expect(reshaped.tree).toBe(treeB);
    expect(reshaped.currentId).toBe("n2");
    expect(reshaped.buffer).toBe("next");
    expect(reshaped.mapSelectedId).toBe("n1");
    expect(reshaped.mapLocateRequest).toBe(3);

    const selected = workspaceReducer(loaded, {
      type: "nodeSelected",
      tree: treeB,
      currentId: "n2",
      buffer: "next",
    });
    // nodeSelected and bufferReshaped have identical effect (distinct names
    // document intent at the call site).
    expect(selected).toEqual(reshaped);
  });

  it("editPersisted relocates the path AND the map selection and bumps locate", () => {
    const next = workspaceReducer(loaded, {
      type: "editPersisted",
      tree: treeB,
      currentId: "n2",
      buffer: "next",
      selectedId: "n2",
    });
    expect(next.tree).toBe(treeB);
    expect(next.currentId).toBe("n2");
    expect(next.buffer).toBe("next");
    expect(next.mapSelectedId).toBe("n2");
    expect(next.mapSelectionIds).toEqual(["n2"]);
    expect(next.mapLocateRequest).toBe(4);
  });

  it("editPersisted can restore a multi-selection during application undo", () => {
    const next = workspaceReducer(loaded, {
      type: "editPersisted",
      tree: treeB,
      currentId: "n2",
      buffer: "next",
      selectedId: "n1",
      selectedIds: ["n1", "n2"],
    });
    expect(next.mapSelectedId).toBe("n1");
    expect(next.mapSelectionIds).toEqual(["n1", "n2"]);
  });

  it("treeMutated swaps the tree but deliberately leaves selection put", () => {
    const next = workspaceReducer(loaded, { type: "treeMutated", tree: treeB });
    expect(next.tree).toBe(treeB);
    expect(next.currentId).toBe("n1");
    expect(next.buffer).toBe("hello");
    expect(next.mapSelectedId).toBe("n1");
    expect(next.mapSelectionIds).toEqual(["n1"]);
    expect(next.mapLocateRequest).toBe(3);
  });
});
