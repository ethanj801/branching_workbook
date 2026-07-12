import { describe, it, expect } from "vitest";
import { expandLineage, prunableDescendants } from "./lineage";
import { type Tree, type TreeNode } from "./types";

function makeNode(id: string, parentId: string | null): TreeNode {
  return {
    id,
    parentId,
    text: "",
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

// root → A → B → C
//        A → D
// root → E
function branchingTree(): Tree {
  const nodes = [
    makeNode("root", null),
    makeNode("A", "root"),
    makeNode("B", "A"),
    makeNode("C", "B"),
    makeNode("D", "A"),
    makeNode("E", "root"),
  ];
  const rec: Record<string, TreeNode> = {};
  for (const n of nodes) rec[n.id] = n;
  return { nodes: rec, rootId: "root" };
}

describe("expandLineage", () => {
  it("includes the seed, its ancestors, and its descendants", () => {
    const result = expandLineage(branchingTree(), ["B"]);
    expect([...result].sort()).toEqual(["A", "B", "C", "root"]);
  });

  it("expands the full subtree beneath a seed but not sibling branches", () => {
    const result = expandLineage(branchingTree(), ["A"]);
    expect([...result].sort()).toEqual(["A", "B", "C", "D", "root"]);
    expect(result.has("E")).toBe(false);
  });

  it("unions ancestors and descendants across multiple seeds", () => {
    const result = expandLineage(branchingTree(), ["C", "E"]);
    expect([...result].sort()).toEqual(["A", "B", "C", "E", "root"]);
    expect(result.has("D")).toBe(false);
  });

  it("covers the whole tree when seeded from the root", () => {
    const result = expandLineage(branchingTree(), ["root"]);
    expect([...result].sort()).toEqual(["A", "B", "C", "D", "E", "root"]);
  });

  it("returns an empty set for no seeds", () => {
    expect(expandLineage(branchingTree(), []).size).toBe(0);
  });

  it("accepts a Set as seeds", () => {
    const result = expandLineage(branchingTree(), new Set(["D"]));
    expect([...result].sort()).toEqual(["A", "D", "root"]);
  });
});

// root → A → B → C
//        A → D
//        A → E → F
// root → G
function pruneTree(): Tree {
  const nodes = [
    makeNode("root", null),
    makeNode("A", "root"),
    makeNode("B", "A"),
    makeNode("C", "B"),
    makeNode("D", "A"),
    makeNode("E", "A"),
    makeNode("F", "E"),
    makeNode("G", "root"),
  ];
  const rec: Record<string, TreeNode> = {};
  for (const n of nodes) rec[n.id] = n;
  return { nodes: rec, rootId: "root" };
}

describe("prunableDescendants", () => {
  it("keeps the spine to a star and everything beneath it, hides the rest", () => {
    const tree = pruneTree();
    tree.nodes["B"] = { ...tree.nodes["B"]!, starred: true };
    const result = prunableDescendants(tree, "A", new Set(["root"]));
    expect(result.sort()).toEqual(["D", "E", "F"]);
  });

  it("keeps descendants of a starred node", () => {
    const tree = pruneTree();
    tree.nodes["E"] = { ...tree.nodes["E"]!, starred: true };
    const result = prunableDescendants(tree, "A", new Set(["root"]));
    expect(result.sort()).toEqual(["B", "C", "D"]);
  });

  it("does not treat the starred anchor as a descendant lineage seed", () => {
    const tree = pruneTree();
    tree.nodes["A"] = { ...tree.nodes["A"]!, starred: true };
    const result = prunableDescendants(tree, "A", new Set(["root"]));
    expect(result.sort()).toEqual(["B", "C", "D", "E", "F"]);
  });

  it("lets a descendant star refine a starred anchor monotonically", () => {
    const tree = pruneTree();
    tree.nodes["A"] = { ...tree.nodes["A"]!, starred: true };
    tree.nodes["E"] = { ...tree.nodes["E"]!, starred: true };
    const result = prunableDescendants(tree, "A", new Set(["root"]));
    expect(result.sort()).toEqual(["B", "C", "D"]);
  });

  it("hides every eligible descendant when the subtree has no stars", () => {
    const result = prunableDescendants(pruneTree(), "A", new Set(["root"]));
    expect(result.sort()).toEqual(["B", "C", "D", "E", "F"]);
  });

  it("never touches nodes outside the anchor's subtree", () => {
    const tree = pruneTree();
    const result = prunableDescendants(tree, "A", new Set(["root"]));
    expect(result).not.toContain("G");
    expect(result).not.toContain("root");
    expect(result).not.toContain("A");
  });

  it("protects the current path even without stars", () => {
    const result = prunableDescendants(
      pruneTree(),
      "A",
      new Set(["root", "A", "E", "F"]),
    );
    expect(result.sort()).toEqual(["B", "C", "D"]);
  });

  it("skips already hidden and deleted nodes", () => {
    const tree = pruneTree();
    tree.nodes["D"] = { ...tree.nodes["D"]!, hidden: true };
    tree.nodes["C"] = { ...tree.nodes["C"]!, deleted: true };
    const result = prunableDescendants(tree, "A", new Set(["root"]));
    expect(result.sort()).toEqual(["B", "E", "F"]);
  });

  it("ignores stars on hidden nodes", () => {
    const tree = pruneTree();
    tree.nodes["B"] = { ...tree.nodes["B"]!, starred: true, hidden: true };
    const result = prunableDescendants(tree, "A", new Set(["root"]));
    expect(result.sort()).toEqual(["C", "D", "E", "F"]);
  });

  it("keeps unstarred continuations below a star out of the hide set across branches", () => {
    const tree = pruneTree();
    tree.nodes["C"] = { ...tree.nodes["C"]!, starred: true };
    tree.nodes["F"] = { ...tree.nodes["F"]!, starred: true };
    const result = prunableDescendants(tree, "A", new Set(["root"]));
    expect(result.sort()).toEqual(["D"]);
  });
});
