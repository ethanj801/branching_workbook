import { describe, it, expect } from "vitest";
import {
  analyzeNodeMapMergeSelection,
  buildMergedSelectionTree,
  buildMergedTree,
  collectLinearChainDownward,
  collectSubtreeNodeIds,
} from "./merge";
import { type NodeSource, type Tree, type TreeNode } from "./types";

function makeNode(
  id: string,
  parentId: string | null,
  text: string,
  source: NodeSource = "user_written",
  extra: Partial<TreeNode> = {},
): TreeNode {
  return {
    id,
    parentId,
    text,
    source,
    role: "user",
    endOfTurn: false,
    hidden: false,
    deleted: false,
    starred: false,
    createdAt: 0,
    priorContextHash: "0".repeat(16),
    ...extra,
  };
}

function makeTree(nodes: TreeNode[]): Tree {
  const rec: Record<string, TreeNode> = {};
  for (const n of nodes) rec[n.id] = n;
  return { nodes: rec, rootId: nodes[0]!.id };
}

// root → A → B → C (one linear run beneath the root)
function linearTree(): Tree {
  return makeTree([
    makeNode("root", null, ""),
    makeNode("A", "root", "Hello ", "user_written"),
    makeNode("B", "A", "world", "user_written"),
    makeNode("C", "B", "!", "user_written"),
  ]);
}

describe("buildMergedTree", () => {
  it("merges a single child up into its parent and reparents grandchildren", () => {
    const merged = buildMergedTree(linearTree(), "A", "B");
    expect(merged).not.toBeNull();
    expect(merged!.nodes.B).toBeUndefined();
    expect(merged!.nodes.A!.text).toBe("Hello world");
    // C followed B up to A
    expect(merged!.nodes.C!.parentId).toBe("A");
  });

  it("marks the merged node 'composed' when the two sources differ", () => {
    const tree = makeTree([
      makeNode("root", null, ""),
      makeNode("A", "root", "a", "user_written"),
      makeNode("B", "A", "b", "generated"),
    ]);
    expect(buildMergedTree(tree, "A", "B")!.nodes.A!.source).toBe("composed");
  });

  it("returns null when the parent has more than one child", () => {
    const tree = makeTree([
      makeNode("root", null, ""),
      makeNode("A", "root", "a"),
      makeNode("B", "A", "b"),
      makeNode("D", "A", "d"),
    ]);
    expect(buildMergedTree(tree, "A", "B")).toBeNull();
  });

  it("returns null when the upstream node is the root", () => {
    expect(buildMergedTree(linearTree(), "root", "A")).toBeNull();
  });

  it("returns null when downstream is not a child of upstream", () => {
    expect(buildMergedTree(linearTree(), "A", "C")).toBeNull();
  });
});

describe("analyzeNodeMapMergeSelection", () => {
  it("accepts a contiguous linear run and orders it parent→child", () => {
    const result = analyzeNodeMapMergeSelection(linearTree(), ["C", "A", "B"]);
    expect(result).toEqual({ ok: true, orderedIds: ["A", "B", "C"] });
  });

  it("rejects a selection of fewer than two nodes", () => {
    const result = analyzeNodeMapMergeSelection(linearTree(), ["A"]);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-contiguous selection", () => {
    // A and C without the connecting B
    const result = analyzeNodeMapMergeSelection(linearTree(), ["A", "C"]);
    expect(result.ok).toBe(false);
  });

  it("rejects merging through a node with multiple children", () => {
    const tree = makeTree([
      makeNode("root", null, ""),
      makeNode("A", "root", "a"),
      makeNode("B", "A", "b"),
      makeNode("D", "A", "d"),
    ]);
    expect(analyzeNodeMapMergeSelection(tree, ["A", "B"]).ok).toBe(false);
  });
});

describe("buildMergedSelectionTree", () => {
  it("concatenates a whole linear run into its first node", () => {
    const merged = buildMergedSelectionTree(linearTree(), ["A", "B", "C"]);
    expect(merged).not.toBeNull();
    expect(merged!.nodes.A!.text).toBe("Hello world!");
    expect(merged!.nodes.B).toBeUndefined();
    expect(merged!.nodes.C).toBeUndefined();
  });

  it("ORs starred across the run", () => {
    const tree = makeTree([
      makeNode("root", null, ""),
      makeNode("A", "root", "a"),
      makeNode("B", "A", "b", "user_written", { starred: true }),
    ]);
    expect(buildMergedSelectionTree(tree, ["A", "B"])!.nodes.A!.starred).toBe(true);
  });

  it("returns null for an invalid selection", () => {
    expect(buildMergedSelectionTree(linearTree(), ["A", "C"])).toBeNull();
  });
});

describe("collectLinearChainDownward", () => {
  it("walks down while each node has exactly one child", () => {
    expect(collectLinearChainDownward(linearTree(), "A")).toEqual(["A", "B", "C"]);
  });

  it("stops at the first branch", () => {
    const tree = makeTree([
      makeNode("root", null, ""),
      makeNode("A", "root", "a"),
      makeNode("B", "A", "b"),
      makeNode("D", "A", "d"),
    ]);
    expect(collectLinearChainDownward(tree, "root")).toEqual(["root", "A"]);
  });
});

describe("collectSubtreeNodeIds", () => {
  it("collects every node beneath (and including) the start", () => {
    const tree = makeTree([
      makeNode("root", null, ""),
      makeNode("A", "root", "a"),
      makeNode("B", "A", "b"),
      makeNode("D", "A", "d"),
    ]);
    expect(collectSubtreeNodeIds(tree, "A").sort()).toEqual(["A", "B", "D"]);
  });
});
