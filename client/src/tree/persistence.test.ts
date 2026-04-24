import { describe, expect, it } from "vitest";
import type { NodeModel } from "../api";
import {
  loadedTreeFromModels,
  mutationBatchFromTrees,
} from "./persistence";
import { concatPathText, pathFromRoot, type Tree, type TreeNode } from "./types";

function model(
  id: string,
  parentId: string | null,
  text: string,
  isMainPath: boolean,
): NodeModel {
  return {
    id,
    parent_id: parentId,
    text,
    source: "user_written",
    hidden: false,
    is_main_path: isMainPath,
    created_at: 1000,
    prior_context_hash: "0".repeat(16),
  };
}

function node(
  id: string,
  parentId: string | null,
  text: string,
  hidden = false,
): TreeNode {
  return {
    id,
    parentId,
    text,
    source: "user_written",
    hidden,
    createdAt: 1000,
    priorContextHash: "0".repeat(16),
  };
}

function tree(nodes: TreeNode[]): Tree {
  return {
    rootId: "root",
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
  };
}

describe("tree persistence helpers", () => {
  it("loads server rows and follows the persisted main path to the leaf", () => {
    const loaded = loadedTreeFromModels([
      model("root", null, "", true),
      model("A", "root", "hello ", true),
      model("B", "A", "world", true),
      model("C", "A", "earth", false),
    ]);

    expect(loaded.currentId).toBe("B");
    expect(concatPathText(pathFromRoot(loaded.tree, loaded.currentId))).toBe(
      "hello world",
    );
  });

  it("diffs trees into creates, updates, deletes, and main_path ids", () => {
    const before = tree([
      node("root", null, ""),
      node("A", "root", "hello "),
      node("C", "A", "old"),
    ]);
    const after = tree([
      node("root", null, ""),
      node("A", "root", "hello ", true),
      node("B", "A", "new"),
    ]);

    const batch = mutationBatchFromTrees(before, after, "B");

    expect(batch.creates?.map((item) => item.id)).toEqual(["B"]);
    expect(batch.updates?.map((item) => item.id)).toEqual(["A"]);
    expect(batch.deletes).toEqual(["C"]);
    expect(batch.main_path).toEqual(["root", "A", "B"]);
  });
});
