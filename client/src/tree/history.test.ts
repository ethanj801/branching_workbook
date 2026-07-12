import { describe, expect, it } from "vitest";
import {
  replaceTreeHistoryWithBoundary,
  treeHistoryLocation,
  treeChangesBetween,
  undoTreeChanges,
  type TreeHistoryItem,
} from "./history";
import { concatPathText, pathFromRoot, type Tree, type TreeNode } from "./types";

function node(id: string, parentId: string | null, text = ""): TreeNode {
  return {
    id,
    parentId,
    text,
    name: null,
    source: "user_written",
    role: "user",
    endOfTurn: false,
    hidden: false,
    deleted: false,
    starred: false,
    createdAt: 0,
    priorContextHash: "0".repeat(16),
  };
}

function tree(...nodes: TreeNode[]): Tree {
  return {
    rootId: "root",
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
  };
}

describe("tree history", () => {
  it("records the actual map selection independently from the active node", () => {
    const currentTree = tree(node("root", null), node("A", "root"), node("B", "A"));

    expect(treeHistoryLocation(currentTree, "B", "A", ["A"])).toEqual({
      currentId: "B",
      selectedId: "A",
      selectionIds: ["A"],
    });
  });

  it("filters stale map selections and falls back to the active node", () => {
    const currentTree = tree(node("root", null), node("A", "root"));

    expect(treeHistoryLocation(currentTree, "A", "missing", ["missing"])).toEqual({
      currentId: "A",
      selectedId: "A",
      selectionIds: ["A"],
    });
  });

  it("collapses inaccessible history into a boundary", () => {
    const location = { currentId: "root", selectedId: "root", selectionIds: ["root"] };
    const history: TreeHistoryItem[] = [
      {
        kind: "entry",
        id: 1,
        label: "Rename node",
        changes: [],
        beforeLocation: location,
        afterLocation: location,
      },
    ];

    const boundary = replaceTreeHistoryWithBoundary(
      history,
      "Submitted chat message",
      "Submitted messages are edited or deleted explicitly.",
    );

    expect(history).toEqual([boundary]);
    expect(boundary.kind).toBe("boundary");
  });

  it("restores only command-owned fields and preserves later unrelated text", () => {
    const before = tree(node("root", null), node("A", "root", "draft"));
    const after = tree(node("root", null), {
      ...node("A", "root", "draft"),
      name: "Introduction",
    });
    const live = tree(node("root", null), {
      ...node("A", "root", "revised"),
      name: "Introduction",
    });

    const result = undoTreeChanges(live, treeChangesBetween(before, after));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree.nodes.A?.name).toBeNull();
    expect(result.tree.nodes.A?.text).toBe("revised");
  });

  it("reverses node creation", () => {
    const before = tree(node("root", null));
    const after = tree(node("root", null), node("A", "root"));

    const result = undoTreeChanges(after, treeChangesBetween(before, after));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tree.nodes.A).toBeUndefined();
  });

  it("recreates physically removed nodes and restores parent links", () => {
    const before = tree(
      node("root", null),
      node("A", "root", "a"),
      node("B", "A", "b"),
      node("C", "B", "c"),
    );
    const after = tree(
      node("root", null),
      { ...node("A", "root", "ab"), source: "composed" },
      node("C", "A", "c"),
    );

    const result = undoTreeChanges(after, treeChangesBetween(before, after));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree).toEqual(before);
  });

  it("rejects merge undo when the surviving node gained a later child", () => {
    const before = tree(
      node("root", null),
      node("A", "root", "a"),
      node("B", "A", "b"),
    );
    const merged = tree(node("root", null), node("A", "root", "ab"));
    const live = tree(
      node("root", null),
      node("A", "root", "ab"),
      node("N", "A", "+new"),
    );

    const result = undoTreeChanges(live, treeChangesBetween(before, merged));

    expect(result).toEqual({
      ok: false,
      reason: "Node A gained later descendants that depend on its merged text.",
    });
  });

  it("allows merge undo when a downstream subtree moves back under the restored node", () => {
    const before = tree(
      node("root", null),
      node("A", "root", "a"),
      node("B", "A", "b"),
      node("C", "B", "c"),
    );
    const merged = tree(
      node("root", null),
      node("A", "root", "ab"),
      node("C", "A", "c"),
    );
    const live = tree(
      node("root", null),
      node("A", "root", "ab"),
      node("C", "A", "c"),
      node("N", "C", "+new"),
    );

    const result = undoTreeChanges(live, treeChangesBetween(before, merged));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree.nodes.C?.parentId).toBe("B");
    expect(result.tree.nodes.N?.parentId).toBe("C");
    expect(concatPathText(pathFromRoot(result.tree, "N"))).toBe("abc+new");
  });

  it("rejects multi-node merge undo after a direct append to the survivor", () => {
    const before = tree(
      node("root", null),
      node("A", "root", "a"),
      node("B", "A", "b"),
      node("C", "B", "c"),
    );
    const merged = tree(node("root", null), node("A", "root", "abc"));
    const live = tree(
      node("root", null),
      node("A", "root", "abc"),
      node("N", "A", "+new"),
    );

    const result = undoTreeChanges(live, treeChangesBetween(before, merged));

    expect(result.ok).toBe(false);
  });

  it("rejects undo when a command-owned field changed later", () => {
    const before = tree(node("root", null), node("A", "root", "a"));
    const after = tree(node("root", null), node("A", "root", "ab"));
    const live = tree(node("root", null), node("A", "root", "edited"));

    const result = undoTreeChanges(live, treeChangesBetween(before, after));

    expect(result).toEqual({
      ok: false,
      reason: "Node A changed after this operation.",
    });
  });

  it("rejects removal of a created node that gained a later child", () => {
    const before = tree(node("root", null));
    const after = tree(node("root", null), node("A", "root"));
    const live = tree(node("root", null), node("A", "root"), node("B", "A"));

    const result = undoTreeChanges(live, treeChangesBetween(before, after));

    expect(result).toEqual({
      ok: false,
      reason: "Created node A gained later descendants.",
    });
  });
});
