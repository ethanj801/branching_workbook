import { describe, expect, it } from "vitest";
import { buildNodeMapLayout } from "./nodeMapLayout";
import type { Tree, TreeNode } from "./tree/types";

function makeNode(
  id: string,
  parentId: string | null,
  text: string,
  name?: string,
): TreeNode {
  return {
    id,
    parentId,
    text,
    name,
    source: "user_written",
    role: "user",
    endOfTurn: false,
    hidden: false,
    starred: false,
    createdAt: 0,
    priorContextHash: "0".repeat(16),
  };
}

function makeTree(nodes: TreeNode[]): Tree {
  return {
    rootId: nodes[0].id,
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  };
}

describe("buildNodeMapLayout", () => {
  it("reserves internal node card width when spacing sibling subtrees", () => {
    const tree = makeTree([
      makeNode("root", null, ""),
      makeNode("left-parent", "root", "", "A very wide named parent card"),
      makeNode("left-leaf", "left-parent", "short"),
      makeNode("right-parent", "root", "", "Another wide named parent card"),
      makeNode("right-leaf", "right-parent", "short"),
    ]);

    const layout = buildNodeMapLayout(tree);
    const leftParent = layout.nodes.find((item) => item.node.id === "left-parent");
    const rightParent = layout.nodes.find((item) => item.node.id === "right-parent");

    expect(leftParent).toBeDefined();
    expect(rightParent).toBeDefined();
    expect(leftParent!.x + leftParent!.width).toBeLessThanOrEqual(rightParent!.x);
  });
});
