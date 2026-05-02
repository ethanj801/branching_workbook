import { childrenOf, type Tree, type TreeNode } from "./tree/types";

export type NodeMapItem = {
  node: TreeNode;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
};

export type NodeMapEdge = {
  parentId: string;
  childId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
};

export type NodeMapLayout = {
  nodes: NodeMapItem[];
  edges: NodeMapEdge[];
  width: number;
  height: number;
};

type NodeMapSubtreeSpan = {
  left: number;
  right: number;
  center: number;
};

const NODE_MAP_NODE_MIN_WIDTH = 156;
const NODE_MAP_NODE_MAX_WIDTH = 224;
const NODE_MAP_NODE_MIN_HEIGHT = 74;
const NODE_MAP_NODE_MAX_HEIGHT = 122;
const NODE_MAP_LEVEL_GAP = 150;
const NODE_MAP_NODE_GAP = 58;
const NODE_MAP_PADDING = 72;

export const NODE_MAP_FIT_PADDING = 36;
export const NODE_MAP_MIN_SCALE = 0.28;
export const NODE_MAP_MAX_SCALE = 1.1;
export const NODE_MAP_PAN_MARGIN = 48;
export const NODE_MAP_MINIMAP_MAX_WIDTH = 172;
export const NODE_MAP_MINIMAP_MAX_HEIGHT = 118;

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function previewText(text: string): string {
  const normalized = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s.,;:!?'"“”‘’()[\]{}\-–—…]+/, "")
    .trim();
  if (!normalized) return "root";
  return normalized.length > 88 ? `${normalized.slice(0, 88)}...` : normalized;
}

export function displayBranchText(text: string): string {
  // Preserve raw continuation text for insertion, but don't make card bodies
  // look indented just because the model correctly emitted a leading space.
  return text.replace(/^\s+/, "");
}

export function nodeLabel(node: TreeNode): string {
  const name = node.name?.trim();
  if (name) return name;
  return previewText(node.text);
}

export function sortedChildrenOf(tree: Tree, nodeIdToSort: string): TreeNode[] {
  return childrenOf(tree, nodeIdToSort).sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}

function nodeMapNodeSize(node: TreeNode): { width: number; height: number } {
  const labelLength = nodeLabel(node).length;
  const bodyLength = displayBranchText(node.text).length;
  return {
    width: clampNumber(
      146 + Math.min(78, labelLength * 1.45),
      NODE_MAP_NODE_MIN_WIDTH,
      NODE_MAP_NODE_MAX_WIDTH,
    ),
    height: clampNumber(
      72 + Math.min(50, Math.floor(bodyLength / 36) * 12),
      NODE_MAP_NODE_MIN_HEIGHT,
      NODE_MAP_NODE_MAX_HEIGHT,
    ),
  };
}

export function buildNodeMapLayout(tree: Tree): NodeMapLayout {
  const rawItems: NodeMapItem[] = [];
  let nextX = 0;

  function place(nodeIdToPlace: string, depth: number): NodeMapSubtreeSpan {
    const node = tree.nodes[nodeIdToPlace];
    if (!node) return { left: nextX, right: nextX, center: nextX };

    const subtreeStart = nextX;
    const rawItemStart = rawItems.length;
    const size = nodeMapNodeSize(node);
    const childNodes = sortedChildrenOf(tree, node.id);
    let centerX: number;
    let spanLeft: number;
    let spanRight: number;
    if (childNodes.length === 0) {
      centerX = nextX + size.width / 2;
      spanLeft = nextX;
      spanRight = nextX + size.width;
    } else {
      const childSpans = childNodes.map((child) => place(child.id, depth + 1));
      centerX =
        (childSpans[0].center + childSpans[childSpans.length - 1].center) / 2;
      const nodeLeft = centerX - size.width / 2;
      const nodeRight = centerX + size.width / 2;
      spanLeft = Math.min(
        nodeLeft,
        ...childSpans.map((span) => span.left),
      );
      spanRight = Math.max(
        nodeRight,
        ...childSpans.map((span) => span.right),
      );

      if (spanLeft < subtreeStart) {
        const shift = subtreeStart - spanLeft;
        for (let index = rawItemStart; index < rawItems.length; index += 1) {
          rawItems[index].x += shift;
        }
        centerX += shift;
        spanLeft += shift;
        spanRight += shift;
      }
    }
    nextX = spanRight + NODE_MAP_NODE_GAP;

    rawItems.push({
      node,
      x: centerX - size.width / 2,
      y: depth * (NODE_MAP_NODE_MAX_HEIGHT + NODE_MAP_LEVEL_GAP),
      width: size.width,
      height: size.height,
      depth,
    });
    return { left: spanLeft, right: spanRight, center: centerX };
  }

  place(tree.rootId, 0);

  const minX = Math.min(...rawItems.map((item) => item.x), 0);
  const minY = Math.min(...rawItems.map((item) => item.y), 0);
  const nodes = rawItems
    .map((item) => ({
      ...item,
      x: item.x - minX + NODE_MAP_PADDING,
      y: item.y - minY + NODE_MAP_PADDING,
    }))
    .sort((a, b) => a.depth - b.depth || a.x - b.x);

  const itemById = new Map(nodes.map((item) => [item.node.id, item]));
  const edges: NodeMapEdge[] = [];
  for (const item of nodes) {
    for (const child of sortedChildrenOf(tree, item.node.id)) {
      const childItem = itemById.get(child.id);
      if (!childItem) continue;
      edges.push({
        parentId: item.node.id,
        childId: child.id,
        fromX: item.x + item.width / 2,
        fromY: item.y + item.height,
        toX: childItem.x + childItem.width / 2,
        toY: childItem.y,
      });
    }
  }

  const width = Math.max(
    640,
    ...nodes.map((item) => item.x + item.width + NODE_MAP_PADDING),
  );
  const height = Math.max(
    520,
    ...nodes.map((item) => item.y + item.height + NODE_MAP_PADDING),
  );

  return { nodes, edges, width, height };
}
