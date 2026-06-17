import { describe, expect, it } from "vitest";

import { starredNavigationNodes } from "./starred";
import type { Tree, TreeNode } from "./types";

function makeNode(
  id: string,
  parentId: string | null,
  overrides: Partial<TreeNode> = {},
): TreeNode {
  return {
    id,
    parentId,
    text: id,
    source: "user_written",
    role: "user",
    endOfTurn: true,
    hidden: false,
    deleted: false,
    starred: false,
    createdAt: 0,
    priorContextHash: "0".repeat(16),
    ...overrides,
  };
}

function makeTree(nodes: TreeNode[]): Tree {
  return {
    rootId: nodes[0]!.id,
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  };
}

describe("starredNavigationNodes", () => {
  it("returns starred nodes without descendants or ancestors", () => {
    const tree = makeTree([
      makeNode("root", null, { createdAt: 0 }),
      makeNode("a", "root", { createdAt: 1, starred: true }),
      makeNode("b", "a", { createdAt: 2 }),
      makeNode("c", "b", { createdAt: 3, starred: true }),
    ]);

    expect(starredNavigationNodes(tree).map((node) => node.id)).toEqual(["a", "c"]);
  });

  it("sorts starred nodes by tree navigation order", () => {
    const tree = makeTree([
      makeNode("root", null, { createdAt: 0 }),
      makeNode("right", "root", { createdAt: 2, starred: true }),
      makeNode("left", "root", { createdAt: 1 }),
      makeNode("left-child", "left", { createdAt: 3, starred: true }),
    ]);

    expect(starredNavigationNodes(tree).map((node) => node.id)).toEqual([
      "left-child",
      "right",
    ]);
  });

  it("keeps hidden starred nodes by default", () => {
    const tree = makeTree([
      makeNode("root", null),
      makeNode("hidden", "root", { hidden: true, starred: true }),
    ]);

    expect(starredNavigationNodes(tree).map((node) => node.id)).toEqual(["hidden"]);
  });

  it("can exclude hidden starred nodes", () => {
    const tree = makeTree([
      makeNode("root", null),
      makeNode("hidden", "root", { hidden: true, starred: true }),
      makeNode("visible", "root", { createdAt: 1, starred: true }),
    ]);

    expect(
      starredNavigationNodes(tree, { includeHidden: false }).map((node) => node.id),
    ).toEqual(["visible"]);
  });

  it("excludes deleted starred nodes", () => {
    const tree = makeTree([
      makeNode("root", null),
      makeNode("deleted", "root", { deleted: true, starred: true }),
      makeNode("kept", "root", { createdAt: 1, starred: true }),
    ]);

    expect(starredNavigationNodes(tree).map((node) => node.id)).toEqual(["kept"]);
  });
});
