import {
  type CSSProperties,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type SetStateAction,
  useMemo,
} from "react";

import { nodeLabel, previewText } from "../nodeMapLayout";
import { expandLineage } from "../tree/lineage";
import { starredNavigationNodes } from "../tree/starred";
import { childrenOf, type Tree, type TreeNode } from "../tree/types";
import StarredNodeList from "./StarredNodeList";

type WorkspaceMode = "compose" | "autocomplete" | "map";

type LinearChain = {
  nodes: TreeNode[];
  successor: TreeNode | null;
};

type TreeSidebarProps = {
  tree: Tree | null;
  currentId: string | null;
  currentPathIds: Set<string>;
  isChatProject: boolean;
  workspaceMode: WorkspaceMode;
  treeVisible: boolean;
  saving: boolean;
  streaming: boolean;
  showHidden: boolean;
  starredOnly: boolean;
  treeSearch: string;
  collapsedNodes: Record<string, boolean>;
  expandedChains: Record<string, boolean>;
  setShowHidden: (value: boolean) => void;
  setStarredOnly: (value: boolean) => void;
  setTreeSearch: (value: string) => void;
  setTreeVisible: (value: boolean) => void;
  setExpandedChains: Dispatch<SetStateAction<Record<string, boolean>>>;
  toggleCollapsed: (id: string) => void;
  toggleChainExpanded: (key: string) => void;
  onSelectNode: (nodeId: string) => void | Promise<void>;
  onSetNodeStarred: (nodeId: string, starred: boolean) => void | Promise<void>;
  openTreeMenu: (nodeId: string, x: number, y: number) => void;
  onTreeResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
};

// The disclosure chevron, shared by tree rows and linear-run rows. Rotated 90°
// counter-clockwise when the row is collapsed/closed.
function TreeCaret({ rotated }: { rotated: boolean }) {
  return (
    <svg
      viewBox="0 0 10 10"
      width="10"
      height="10"
      aria-hidden="true"
      style={{
        transform: rotated ? "rotate(-90deg)" : "rotate(0deg)",
        transition: "transform 120ms ease",
      }}
    >
      <path
        d="M2 3.5 L5 6.5 L8 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The left navigation panel: filter toggles, the node-name search, and the
 * tree itself (with linear runs collapsed into a single expandable summary).
 * Presentational — the tree, selection, filters, and all node actions are
 * owned by App and passed in as props. Rendered as two grid siblings (the
 * panel/rail and the resize splitter) so it slots straight into the workspace
 * grid; returns null outside compose/chat modes.
 */
export default function TreeSidebar({
  tree,
  currentId,
  currentPathIds,
  isChatProject,
  workspaceMode,
  treeVisible,
  saving,
  streaming,
  showHidden,
  starredOnly,
  treeSearch,
  collapsedNodes,
  expandedChains,
  setShowHidden,
  setStarredOnly,
  setTreeSearch,
  setTreeVisible,
  setExpandedChains,
  toggleCollapsed,
  toggleChainExpanded,
  onSelectNode,
  onSetNodeStarred,
  openTreeMenu,
  onTreeResizeStart,
}: TreeSidebarProps) {
  const starredLineageIds = useMemo<Set<string> | null>(() => {
    if (!tree) return null;
    const starredIds = Object.values(tree.nodes)
      .filter((node) => node.starred)
      .map((node) => node.id);
    if (starredIds.length === 0) return null;
    return expandLineage(tree, starredIds);
  }, [tree]);
  const quickStarredNodes = useMemo(
    () => (tree ? starredNavigationNodes(tree) : []),
    [tree],
  );

  // Search lineage: nodes worth showing when a search query is active. A
  // node passes if its label (name or text preview) contains the query, or
  // if it's an ancestor or descendant of one that does — same shape as the
  // starred filter. Empty query → null (filter is a no-op).
  const searchMatchIds = useMemo<Set<string> | null>(() => {
    if (!tree) return null;
    const query = treeSearch.trim().toLowerCase();
    if (query.length === 0) return null;
    return new Set(
      Object.values(tree.nodes)
        .filter((node) => nodeLabel(node).toLowerCase().includes(query))
        .map((node) => node.id),
    );
  }, [tree, treeSearch]);

  const searchLineageIds = useMemo<Set<string> | null>(() => {
    if (!tree || searchMatchIds === null) return null;
    if (searchMatchIds.size === 0) return new Set<string>();
    return expandLineage(tree, searchMatchIds);
  }, [searchMatchIds, tree]);
  const searchMatchCount = searchMatchIds?.size ?? null;
  const hasStarredNodes =
    tree !== null && Object.values(tree.nodes).some((node) => node.starred);
  const activeHiddenByFilters =
    tree !== null &&
    currentId !== null &&
    ((starredOnly && starredLineageIds !== null && !starredLineageIds.has(currentId)) ||
      (searchLineageIds !== null && !searchLineageIds.has(currentId)));
  const searchHasNoMatches = searchMatchCount === 0;
  const treeFilterNote = searchHasNoMatches
    ? "No node names match this search. Showing your current path for context."
    : starredOnly && !hasStarredNodes
      ? "No starred nodes yet. Star a node to use this filter."
      : activeHiddenByFilters
        ? "Current path is pinned because filters would otherwise hide it."
        : null;

  function visibleTreeChildren(node: TreeNode): TreeNode[] {
    if (!tree) return [];
    return childrenOf(tree, node.id)
      .filter((child) => !child.deleted)
      .filter((child) => showHidden || !child.hidden || currentPathIds.has(child.id))
      .filter(
        (child) =>
          !starredOnly ||
          starredLineageIds === null ||
          starredLineageIds.has(child.id) ||
          currentPathIds.has(child.id),
      )
      .filter(
        (child) =>
          searchLineageIds === null ||
          searchLineageIds.has(child.id) ||
          currentPathIds.has(child.id),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  function visibleTreeNodeCount(): number {
    if (!tree) return 0;
    return Object.values(tree.nodes).filter((node) => {
      if (node.parentId === null) return true;
      if (node.deleted) return false;
      if (!showHidden && node.hidden && !currentPathIds.has(node.id)) return false;
      if (
        starredOnly &&
        starredLineageIds !== null &&
        !starredLineageIds.has(node.id) &&
        !currentPathIds.has(node.id)
      ) {
        return false;
      }
      if (
        searchLineageIds !== null &&
        !searchLineageIds.has(node.id) &&
        !currentPathIds.has(node.id)
      ) {
        return false;
      }
      return true;
    }).length;
  }

  function isLinearChainBoundary(node: TreeNode, childNodes: TreeNode[]): boolean {
    return (
      node.id === tree?.rootId ||
      node.id === currentId ||
      node.hidden ||
      node.starred ||
      !!node.name?.trim() ||
      childNodes.length > 1
    );
  }

  function collectLinearChain(startNodeId: string): LinearChain | null {
    if (!tree || treeSearch.trim()) return null;

    const nodes: TreeNode[] = [];
    let cursor: TreeNode | undefined = tree.nodes[startNodeId];
    let successor: TreeNode | null = null;

    while (cursor) {
      const childNodes = visibleTreeChildren(cursor);
      if (isLinearChainBoundary(cursor, childNodes)) {
        successor = cursor;
        break;
      }

      nodes.push(cursor);
      if (childNodes.length === 0) break;
      cursor = childNodes[0];
    }

    return nodes.length >= 2 ? { nodes, successor } : null;
  }

  function linearChainKey(chain: LinearChain): string {
    return chain.nodes.map((node) => node.id).join(">");
  }

  function renderTreeEntry(nodeIdToRender: string, depth = 0) {
    const chain = collectLinearChain(nodeIdToRender);
    if (chain) return renderLinearChain(chain, depth);
    return renderTreeNode(nodeIdToRender, depth);
  }

  function renderTreeNode(
    nodeIdToRender: string,
    depth = 0,
    options: { renderChildren?: boolean; hideCaret?: boolean; key?: string } = {},
  ) {
    if (!tree) return null;
    const node = tree.nodes[nodeIdToRender];
    if (!node) return null;

    const childNodes =
      options.renderChildren === false ? [] : visibleTreeChildren(node);
    const isCurrent = node.id === currentId;
    const isOnPath = currentPathIds.has(node.id);
    const hasChildren = !options.hideCaret && childNodes.length > 0;
    const isCollapsed = !!collapsedNodes[node.id];

    return (
      <div key={options.key ?? node.id}>
        <div
          className="bw-tree-row-wrap"
          style={{ "--depth": `${Math.min(depth, 10) * 0.55}rem` } as CSSProperties}
        >
          {hasChildren ? (
            <button
              type="button"
              className="bw-tree-caret"
              aria-label={isCollapsed ? "Expand" : "Collapse"}
              aria-expanded={!isCollapsed}
              onClick={(event) => {
                event.stopPropagation();
                toggleCollapsed(node.id);
              }}
            >
              <TreeCaret rotated={isCollapsed} />
            </button>
          ) : (
            <span className="bw-tree-caret bw-tree-caret-empty" aria-hidden="true" />
          )}
          <button
            type="button"
            className="bw-tree-star"
            data-on={node.starred}
            aria-label={node.starred ? "Unstar node" : "Star node"}
            aria-pressed={node.starred}
            title={node.starred ? "Unstar" : "Star"}
            disabled={streaming || saving}
            onClick={(event) => {
              event.stopPropagation();
              void onSetNodeStarred(node.id, !node.starred);
            }}
          >
            {node.starred ? "★" : "☆"}
          </button>
          <button
            type="button"
            onClick={() => void onSelectNode(node.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openTreeMenu(node.id, event.clientX, event.clientY);
            }}
            disabled={streaming || saving}
            className="bw-tree-row"
            data-current={isCurrent}
            data-path={isOnPath}
            data-hidden={node.hidden}
            data-starred={node.starred}
          >
            <span className="bw-tree-preview">{nodeLabel(node)}</span>
            <span className="bw-tree-meta">
              <span>{node.source.replace("_", " ")}</span>
              {hasChildren && <span>{childNodes.length} branch</span>}
            </span>
          </button>
        </div>
        {!isCollapsed &&
          childNodes.map((child) => renderTreeEntry(child.id, depth + 1))}
      </div>
    );
  }

  function renderLinearChain(chain: LinearChain, depth = 0) {
    const key = linearChainKey(chain);
    const expanded = !!expandedChains[key];
    const first = chain.nodes[0]!;
    const last = chain.nodes[chain.nodes.length - 1]!;
    const destination = chain.successor ?? last;
    const visibleCount = chain.nodes.length + (chain.successor ? 1 : 0);
    const chainOnPath =
      chain.nodes.some((node) => currentPathIds.has(node.id)) ||
      (chain.successor !== null && currentPathIds.has(chain.successor.id));
    const summary = `${visibleCount} nodes · "${previewText(first.text)}" -> "${previewText(destination.text)}"`;

    return (
      <div key={`chain-${key}`} className="bw-tree-chain">
        <div
          className="bw-tree-row-wrap"
          style={{ "--depth": `${Math.min(depth, 10) * 0.55}rem` } as CSSProperties}
        >
          <button
            type="button"
            className="bw-tree-caret"
            aria-label={expanded ? "Collapse linear run" : "Expand linear run"}
            aria-expanded={expanded}
            onClick={(event) => {
              event.stopPropagation();
              toggleChainExpanded(key);
            }}
          >
            <TreeCaret rotated={!expanded} />
          </button>
          <span className="bw-tree-star bw-tree-star-spacer" aria-hidden="true" />
          <button
            type="button"
            className="bw-tree-chain-row"
            data-path={chainOnPath}
            onClick={() => {
              setExpandedChains((prev) => ({ ...prev, [key]: true }));
              void onSelectNode(destination.id);
            }}
            title={`Go to ${nodeLabel(destination)}`}
          >
            <span className="bw-tree-chain-summary">... {summary}</span>
          </button>
        </div>
        {expanded
          ? chain.nodes
              .map((node, index) =>
                renderTreeNode(node.id, depth + index, {
                  key: `chain-${key}-${node.id}`,
                  renderChildren: false,
                  hideCaret: true,
                }),
              )
              .concat(
                chain.successor
                  ? [renderTreeEntry(chain.successor.id, depth + chain.nodes.length)]
                  : [],
              )
          : chain.successor
            ? renderTreeEntry(chain.successor.id, depth)
            : null}
      </div>
    );
  }

  if (!tree || !currentId) return null;
  if (!(isChatProject || workspaceMode === "compose")) return null;

  return (
    <>
      {treeVisible ? (
        <aside className="bw-tree">
          <div className="bw-rail-head">
            <div>
              <div className="bw-kicker">Tree</div>
            </div>
            <div className="bw-tree-toggles">
              <label className="bw-hidden-toggle">
                <input
                  type="checkbox"
                  checked={showHidden}
                  onChange={(event) => setShowHidden(event.target.checked)}
                />
                <span>Show hidden</span>
              </label>
              <label className="bw-hidden-toggle">
                <input
                  type="checkbox"
                  checked={starredOnly}
                  onChange={(event) => setStarredOnly(event.target.checked)}
                />
                <span>Only starred paths</span>
              </label>
            </div>
          </div>
          <div className="bw-tree-search">
            <input
              type="search"
              value={treeSearch}
              onChange={(event) => setTreeSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setTreeSearch("");
                }
              }}
              placeholder="Search node names..."
              className="bw-tree-search-input"
              aria-label="Search tree by node name"
            />
            {treeSearch && (
              <button
                type="button"
                className="bw-tree-search-clear"
                onClick={() => setTreeSearch("")}
                aria-label="Clear search"
                title="Clear"
              >
                ×
              </button>
            )}
          </div>
          <StarredNodeList
            nodes={quickStarredNodes}
            currentId={currentId}
            disabled={saving || streaming}
            onSelectNode={onSelectNode}
          />
          <div className="bw-tree-list">
            {treeFilterNote && (
              <div className="bw-tree-filter-note">{treeFilterNote}</div>
            )}
            {renderTreeNode(tree.rootId)}
          </div>
          <div className="bw-tree-foot">
            {visibleTreeNodeCount().toLocaleString()} visible ·{" "}
            {Object.keys(tree.nodes).length.toLocaleString()} total
          </div>
        </aside>
      ) : (
        <div className="bw-collapsed-rail bw-collapsed-rail-left">
          <button
            type="button"
            className="bw-edge-toggle bw-edge-toggle-tree bw-edge-toggle-collapsed"
            onClick={() => setTreeVisible(true)}
            aria-label="Show tree panel"
            title="Show tree"
          >
            ›
          </button>
        </div>
      )}

      {treeVisible && (
        <div
          className="bw-splitter bw-tree-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize tree column"
          onMouseDown={onTreeResizeStart}
        >
          <button
            type="button"
            className="bw-edge-toggle bw-edge-toggle-tree"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => setTreeVisible(false)}
            aria-label="Hide tree panel"
            title="Hide tree"
          >
            ‹
          </button>
        </div>
      )}
    </>
  );
}
