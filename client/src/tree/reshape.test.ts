import { describe, it, expect, beforeEach } from "vitest";
import { reshape } from "./reshape";
import {
  concatPathText,
  pathFromRoot,
  type Tree,
  type TreeNode,
  type NodeSource,
} from "./types";

let nextIdCounter = 0;
const nid = () => `n${++nextIdCounter}`;
const now = () => 1000;

beforeEach(() => {
  nextIdCounter = 0;
});

function makeNode(
  id: string,
  parentId: string | null,
  text: string,
  source: NodeSource = "user_written",
  hidden = false,
): TreeNode {
  return {
    id,
    parentId,
    text,
    source,
    hidden,
    starred: false,
    createdAt: 0,
    priorContextHash: "0".repeat(16),
  };
}

function makeTree(nodes: TreeNode[]): Tree {
  const rec: Record<string, TreeNode> = {};
  for (const n of nodes) rec[n.id] = n;
  return { nodes: rec, rootId: nodes[0].id };
}

describe("reshape — §3.1 buffer-authoritative tree split", () => {
  it("test_pure_append: divergent suffix becomes a new user_written child of the leaf", () => {
    const root = makeNode("root", null, "");
    const A = makeNode("A", "root", "Hello ", "user_written");
    const B = makeNode("B", "A", "world.", "generated");
    const tree = makeTree([root, A, B]);
    const buffer = "Hello world. Goodbye.";

    const out = reshape(tree, "B", buffer, { newId: nid, now });

    const path = pathFromRoot(out.tree, out.currentId);
    expect(concatPathText(path)).toBe(buffer);

    const current = out.tree.nodes[out.currentId];
    expect(current.parentId).toBe("B");
    expect(current.text).toBe(" Goodbye.");
    expect(current.source).toBe("user_written");
    expect(current.priorContextHash).not.toBe("0".repeat(16));
  });

  it("test_edit_inside_ancestor: splits the ancestor when LCP falls strictly inside a node", () => {
    const root = makeNode("root", null, "");
    const A = makeNode("A", "root", "The cat sat on the mat and purred.", "generated");
    const tree = makeTree([root, A]);
    const buffer = "The cat sat on the chair, then yawned.";

    const out = reshape(tree, "A", buffer, { newId: nid, now });

    expect(out.tree.nodes["A"]).toBeUndefined();

    const path = pathFromRoot(out.tree, out.currentId);
    expect(concatPathText(path)).toBe(buffer);

    const current = out.tree.nodes[out.currentId];
    expect(current.text).toBe("chair, then yawned.");
    expect(current.source).toBe("user_written");

    const parent = out.tree.nodes[current.parentId!];
    expect(parent.text).toBe("The cat sat on the ");
    expect(parent.source).toBe("user_written");

    const siblings = Object.values(out.tree.nodes).filter(
      (n) => n.parentId === parent.id && n.id !== current.id,
    );
    expect(siblings).toHaveLength(1);
    expect(siblings[0].text).toBe("mat and purred.");
    expect(siblings[0].source).toBe("generated");
  });

  it("test_delete_into_ancestor: prefix-shorter buffer splits with no new user node", () => {
    const root = makeNode("root", null, "");
    const A = makeNode("A", "root", "aaa", "user_written");
    const B = makeNode("B", "A", "bbb", "generated");
    const C = makeNode("C", "B", "ccc", "generated");
    const tree = makeTree([root, A, B, C]);
    const buffer = "aaab";

    const out = reshape(tree, "C", buffer, { newId: nid, now });

    const path = pathFromRoot(out.tree, out.currentId);
    expect(concatPathText(path)).toBe(buffer);

    const current = out.tree.nodes[out.currentId];
    expect(current.text).toBe("b");
    expect(current.source).toBe("user_written");

    const siblings = Object.values(out.tree.nodes).filter(
      (n) => n.parentId === current.id,
    );
    expect(siblings).toHaveLength(1);
    const bSecond = siblings[0];
    expect(bSecond.text).toBe("bb");
    expect(bSecond.source).toBe("generated");

    const cReparented = Object.values(out.tree.nodes).find((n) => n.text === "ccc");
    expect(cReparented?.parentId).toBe(bSecond.id);

    // Original B is gone; its split replaces it
    expect(out.tree.nodes["B"]).toBeUndefined();
  });

  it("test_edit_recreates_sibling: reattaches to a matching hidden sibling", () => {
    const root = makeNode("root", null, "");
    const A = makeNode("A", "root", "hello ", "user_written");
    const B = makeNode("B", "A", "world", "generated");
    const H = makeNode("H", "A", "earth", "generated", true);
    const tree = makeTree([root, A, B, H]);
    const buffer = "hello earth";

    const out = reshape(tree, "B", buffer, { newId: nid, now });

    expect(out.currentId).toBe("H");
    expect(out.tree.nodes["H"].hidden).toBe(false);
    // B is still in the tree, untouched
    expect(out.tree.nodes["B"]).toBeDefined();
    expect(out.tree.nodes["B"].text).toBe("world");
  });

  it("reattaches to a matching multi-node branch instead of duplicating it", () => {
    const root = makeNode("root", null, "");
    const A = makeNode("A", "root", "hello ", "user_written");
    const B = makeNode("B", "A", "world", "generated");
    const H1 = makeNode("H1", "A", "earth", "generated", true);
    const H2 = makeNode("H2", "H1", "rise", "generated", true);
    const tree = makeTree([root, A, B, H1, H2]);
    const buffer = "hello earthrise";

    const out = reshape(tree, "B", buffer, { newId: nid, now });

    expect(out.currentId).toBe("H2");
    expect(Object.keys(out.tree.nodes).sort()).toEqual(["A", "B", "H1", "H2", "root"]);
    expect(out.tree.nodes["H1"].hidden).toBe(false);
    expect(out.tree.nodes["H2"].hidden).toBe(false);
    expect(concatPathText(pathFromRoot(out.tree, out.currentId))).toBe(buffer);
  });

  it("test_paste_replaces_whole_buffer: LCP=0 makes a new sibling under the root", () => {
    const root = makeNode("root", null, "");
    const A = makeNode("A", "root", "hello world", "generated");
    const tree = makeTree([root, A]);
    const buffer = "completely different text";

    const out = reshape(tree, "A", buffer, { newId: nid, now });

    const path = pathFromRoot(out.tree, out.currentId);
    expect(concatPathText(path)).toBe(buffer);

    const current = out.tree.nodes[out.currentId];
    expect(current.parentId).toBe("root");
    expect(current.text).toBe("completely different text");
    expect(current.source).toBe("user_written");

    expect(out.tree.nodes["A"]).toBeDefined();
    expect(out.tree.nodes["A"].parentId).toBe("root");
  });

  it("test_no_op_edit: buffer matches active path exactly — tree returned unchanged", () => {
    const root = makeNode("root", null, "");
    const A = makeNode("A", "root", "hello ", "user_written");
    const B = makeNode("B", "A", "world", "generated");
    const tree = makeTree([root, A, B]);
    const buffer = "hello world";

    const out = reshape(tree, "B", buffer, { newId: nid, now });

    expect(out.currentId).toBe("B");
    expect(Object.keys(out.tree.nodes).sort()).toEqual(["A", "B", "root"]);
    expect(out.tree.nodes["B"].text).toBe("world");
    expect(out.tree).toBe(tree);
  });

  it("composed source option: divergent becomes a composed node", () => {
    const root = makeNode("root", null, "");
    const A = makeNode("A", "root", "hi", "user_written");
    const tree = makeTree([root, A]);
    const buffer = "hi there";

    const out = reshape(tree, "A", buffer, {
      newId: nid,
      now,
      source: "composed",
    });

    expect(out.tree.nodes[out.currentId].source).toBe("composed");
  });
});
