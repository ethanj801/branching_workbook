import type { Tree, TreeNode } from "./types";

type NodeField = Exclude<keyof TreeNode, "id">;

const NODE_FIELD_SET = {
  parentId: true,
  text: true,
  name: true,
  source: true,
  role: true,
  endOfTurn: true,
  hidden: true,
  deleted: true,
  starred: true,
  createdAt: true,
  priorContextHash: true,
  samplerSnapshot: true,
  seed: true,
  modelId: true,
} satisfies Record<NodeField, true>;

const NODE_FIELDS = Object.keys(NODE_FIELD_SET) as NodeField[];

export type NodeFieldChange = {
  field: NodeField;
  before: unknown;
  after: unknown;
};

export type TreeNodeChange =
  | { type: "update"; nodeId: string; fields: NodeFieldChange[] }
  | { type: "create"; node: TreeNode }
  | { type: "remove"; node: TreeNode };

export type TreeHistoryLocation = {
  currentId: string;
  selectedId: string;
  selectionIds: string[];
};

export type TreeHistoryEntry = {
  kind: "entry";
  id: number;
  label: string;
  changes: TreeNodeChange[];
  beforeLocation: TreeHistoryLocation;
  afterLocation: TreeHistoryLocation;
};

export type TreeHistoryBoundary = {
  kind: "boundary";
  label: string;
  reason: string;
};

export type TreeHistoryItem = TreeHistoryEntry | TreeHistoryBoundary;

export type RecordTreeHistoryInput = {
  label: string;
  beforeTree: Tree;
  afterTree: Tree;
  beforeLocation: TreeHistoryLocation;
  afterLocation: TreeHistoryLocation;
};

export type RecordTreeHistory = (
  input: RecordTreeHistoryInput,
) => TreeHistoryEntry | null;

/**
 * Snapshot the map selection that actually accompanies a tree location. Drop
 * stale ids and fall back to the active node only when the selection has no
 * valid anchor; callers may use different trees for the before/after snapshots
 * when a command removes nodes without deliberately moving map selection.
 */
export function treeHistoryLocation(
  tree: Tree,
  currentId: string,
  selectedId: string | null,
  selectionIds: readonly string[],
): TreeHistoryLocation {
  const validSelectedId = selectedId && tree.nodes[selectedId] ? selectedId : currentId;
  const validSelectionIds = selectionIds.filter((id) => tree.nodes[id]);
  return {
    currentId,
    selectedId: validSelectedId,
    selectionIds:
      validSelectionIds.length > 0 && validSelectionIds.includes(validSelectedId)
        ? validSelectionIds
        : [validSelectedId],
  };
}

/**
 * A non-undoable command or an unavailable inverse closes access to every
 * older entry. Retain one boundary so newer commands can still be recorded and
 * undone without ever falling through to history whose dependencies are no
 * longer provably safe.
 */
export function replaceTreeHistoryWithBoundary(
  history: TreeHistoryItem[],
  label: string,
  reason: string,
): TreeHistoryBoundary {
  const boundary: TreeHistoryBoundary = { kind: "boundary", label, reason };
  history.splice(0, history.length, boundary);
  return boundary;
}

export type UndoTreeResult = { ok: true; tree: Tree } | { ok: false; reason: string };

function fieldValue(node: TreeNode, field: NodeField): unknown {
  return node[field];
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function nodesEqual(a: TreeNode, b: TreeNode): boolean {
  return (
    a.id === b.id &&
    NODE_FIELDS.every((field) =>
      valuesEqual(fieldValue(a, field), fieldValue(b, field)),
    )
  );
}

/**
 * Describe exactly what a persisted command changed. Updates are field-level
 * so undoing metadata never overwrites unrelated text saved outside the
 * application history. Creates/removals retain complete node snapshots because
 * existence itself is the command-owned state.
 */
export function treeChangesBetween(before: Tree, after: Tree): TreeNodeChange[] {
  const changes: TreeNodeChange[] = [];
  const ids = new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)]);

  for (const id of ids) {
    const beforeNode = before.nodes[id];
    const afterNode = after.nodes[id];
    if (!beforeNode && afterNode) {
      changes.push({ type: "create", node: afterNode });
      continue;
    }
    if (beforeNode && !afterNode) {
      changes.push({ type: "remove", node: beforeNode });
      continue;
    }
    if (!beforeNode || !afterNode) continue;

    const fields: NodeFieldChange[] = [];
    for (const field of NODE_FIELDS) {
      const beforeValue = fieldValue(beforeNode, field);
      const afterValue = fieldValue(afterNode, field);
      if (!valuesEqual(beforeValue, afterValue)) {
        fields.push({ field, before: beforeValue, after: afterValue });
      }
    }
    if (fields.length > 0) changes.push({ type: "update", nodeId: id, fields });
  }

  return changes;
}

/**
 * Apply a command's inverse to the live tree. Every command-owned value must
 * still match its recorded post-state; otherwise a text commit or external
 * mutation made the inverse ambiguous and undo fails without changing data.
 */
export function undoTreeChanges(
  tree: Tree,
  changes: readonly TreeNodeChange[],
): UndoTreeResult {
  const createdIds = new Set(
    changes.flatMap((change) => (change.type === "create" ? [change.node.id] : [])),
  );
  const removedNodeParentIds = new Set(
    changes.flatMap((change) =>
      change.type === "remove" && change.node.parentId !== null
        ? [change.node.parentId]
        : [],
    ),
  );

  function remainsChildAfterUndo(node: TreeNode, parentId: string): boolean {
    if (createdIds.has(node.id)) return false;
    const update = changes.find(
      (change): change is Extract<TreeNodeChange, { type: "update" }> =>
        change.type === "update" && change.nodeId === node.id,
    );
    const parentChange = update?.fields.find((field) => field.field === "parentId");
    return parentChange === undefined || parentChange.before === parentId;
  }

  for (const change of changes) {
    if (change.type === "update") {
      const current = tree.nodes[change.nodeId];
      if (!current) {
        return { ok: false, reason: `Node ${change.nodeId} no longer exists.` };
      }
      for (const field of change.fields) {
        if (!valuesEqual(fieldValue(current, field.field), field.after)) {
          return {
            ok: false,
            reason: `Node ${change.nodeId} changed after this operation.`,
          };
        }
      }
      const restoresRemovedChild = removedNodeParentIds.has(change.nodeId);
      const restoresShorterText = change.fields.some(
        (field) =>
          field.field === "text" &&
          typeof field.before === "string" &&
          typeof field.after === "string" &&
          field.before.length < field.after.length,
      );
      if (restoresRemovedChild && restoresShorterText) {
        const retainedChild = Object.values(tree.nodes).find(
          (node) =>
            node.parentId === change.nodeId &&
            remainsChildAfterUndo(node, change.nodeId),
        );
        if (retainedChild) {
          return {
            ok: false,
            reason: `Node ${change.nodeId} gained later descendants that depend on its merged text.`,
          };
        }
      }
      continue;
    }

    if (change.type === "create") {
      const current = tree.nodes[change.node.id];
      if (!current || !nodesEqual(current, change.node)) {
        return {
          ok: false,
          reason: `Created node ${change.node.id} changed after this operation.`,
        };
      }
      const unrelatedChild = Object.values(tree.nodes).find(
        (node) => node.parentId === change.node.id && !createdIds.has(node.id),
      );
      if (unrelatedChild) {
        return {
          ok: false,
          reason: `Created node ${change.node.id} gained later descendants.`,
        };
      }
      continue;
    }

    if (tree.nodes[change.node.id]) {
      return {
        ok: false,
        reason: `Removed node ${change.node.id} has already been recreated.`,
      };
    }
  }

  const nextNodes = { ...tree.nodes };
  for (const change of changes) {
    if (change.type === "update") {
      const current = nextNodes[change.nodeId]!;
      const restored = { ...current } as TreeNode;
      for (const field of change.fields) {
        Object.assign(restored, { [field.field]: field.before });
      }
      nextNodes[change.nodeId] = restored;
    } else if (change.type === "create") {
      delete nextNodes[change.node.id];
    } else {
      nextNodes[change.node.id] = change.node;
    }
  }

  return { ok: true, tree: { rootId: tree.rootId, nodes: nextNodes } };
}
