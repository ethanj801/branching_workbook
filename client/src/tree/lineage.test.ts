import { describe, it, expect } from "vitest";
import { expandLineage } from "./lineage";
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
