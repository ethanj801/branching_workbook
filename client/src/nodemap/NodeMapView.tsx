import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  type WheelEvent as ReactWheelEvent,
} from "react";

import {
  NODE_MAP_FIT_PADDING,
  NODE_MAP_MINIMAP_MAX_HEIGHT,
  NODE_MAP_MINIMAP_MAX_WIDTH,
  buildNodeMapLayout,
  clampNodeMapPan,
  clampNodeMapScale,
  clampNumber,
  nodeLabel,
} from "../nodeMapLayout";
import { childrenOf, type Tree, type TreeNode } from "../tree/types";
import {
  analyzeNodeMapMergeSelection,
  collectLinearChainDownward,
} from "../tree/merge";
import { useLatestRef } from "../useLatestRef";

type MapTooltip = { text: string; x: number; y: number };

type NodeMapDrag = {
  pointerId: number;
  startX: number;
  startY: number;
  panX: number;
  panY: number;
  moved: boolean;
};

type NodeMapMarquee = {
  pointerId: number;
  startCanvas: { x: number; y: number };
  currentCanvas: { x: number; y: number };
  baseSelection: string[];
};

type WorkspaceMode = "compose" | "autocomplete" | "map";

type NodeMapViewProps = {
  tree: Tree | null;
  currentId: string | null;
  currentNode: TreeNode | null;
  currentPathIds: Set<string>;
  saving: boolean;
  streaming: boolean;
  // Selection is co-owned: App's persistTreeEdit and the selection-validation
  // effect also write it, so it lives in App and is threaded down here.
  mapSelectedId: string | null;
  mapSelectionIds: string[];
  mapLocateRequest: number;
  setMapSelectedId: Dispatch<SetStateAction<string | null>>;
  setMapSelectionIds: Dispatch<SetStateAction<string[]>>;
  setMapLocateRequest: Dispatch<SetStateAction<number>>;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
  openTreeMenu: (nodeId: string, x: number, y: number) => void;
  onSelectNode: (nodeId: string) => void | Promise<void>;
  onSetNodeStarred: (nodeId: string, starred: boolean) => void | Promise<void>;
  onSetNodeHidden: (nodeId: string, hidden: boolean) => void | Promise<void>;
  onDeleteMapNode: (nodeId: string) => void | Promise<void>;
  onDeleteMapSelection: (nodeIds: string[]) => void | Promise<void>;
  onHideMapSelection: (nodeIds: string[]) => void | Promise<void>;
  onMergeMapSelection: (nodeIds: string[]) => void | Promise<void>;
  onMergeLinearChainDown: (nodeId: string) => void | Promise<void>;
  onMergeNodeIntoParent: (nodeId: string) => void | Promise<void>;
  onMergeNodeWithOnlyChild: (nodeId: string) => void | Promise<void>;
  onUndoLastDelete: () => void | Promise<void>;
};

/**
 * The node-map workspace: a pan/zoom canvas of the tree with a selection
 * inspector, action buttons, and a minimap. It owns its own view state
 * (pan/zoom/drag/marquee/tooltip), but selection and all tree-mutating actions
 * are owned by App (they go through App's commit/persist/undo machinery) and
 * passed in as props. Only mounted while in map mode, so the effects/listeners
 * here don't need to guard on workspaceMode.
 */
export default function NodeMapView({
  tree,
  currentId,
  currentNode,
  currentPathIds,
  saving,
  streaming,
  mapSelectedId,
  mapSelectionIds,
  mapLocateRequest,
  setMapSelectedId,
  setMapSelectionIds,
  setMapLocateRequest,
  setWorkspaceMode,
  openTreeMenu,
  onSelectNode,
  onSetNodeStarred,
  onSetNodeHidden,
  onDeleteMapNode,
  onDeleteMapSelection,
  onHideMapSelection,
  onMergeMapSelection,
  onMergeLinearChainDown,
  onMergeNodeIntoParent,
  onMergeNodeWithOnlyChild,
  onUndoLastDelete,
}: NodeMapViewProps) {
  const [mapPan, setMapPan] = useState({ x: 0, y: 0 });
  const [mapScale, setMapScale] = useState(1);
  const [mapDragging, setMapDragging] = useState(false);
  const [mapFitRequest, setMapFitRequest] = useState(0);
  const [mapViewportSize, setMapViewportSize] = useState({ width: 0, height: 0 });
  const [mapTooltip, setMapTooltip] = useState<MapTooltip | null>(null);
  const [mapShowHidden, setMapShowHidden] = useState(false);
  const [mapMarquee, setMapMarquee] = useState<NodeMapMarquee | null>(null);

  const mapViewportRef = useRef<HTMLDivElement | null>(null);
  const mapDragRef = useRef<NodeMapDrag | null>(null);
  const mapMarqueeRef = useRef<NodeMapMarquee | null>(null);
  const mapSuppressClickRef = useRef(false);
  const lastHandledFitRequestRef = useRef(0);
  const lastHandledLocateRequestRef = useRef(0);

  const nodeMapVisibleTree = useMemo(() => {
    if (!tree) return null;
    const keep = new Set<string>();
    const stack = [tree.rootId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      const node = tree.nodes[id];
      if (!node) continue;
      if (node.deleted) continue;
      if (!mapShowHidden && node.hidden && !currentPathIds.has(id)) continue;
      keep.add(id);
      for (const child of childrenOf(tree, id)) stack.push(child.id);
    }
    const nextNodes: typeof tree.nodes = {};
    for (const id of keep) {
      const node = tree.nodes[id];
      if (node) nextNodes[id] = node;
    }
    return { rootId: tree.rootId, nodes: nextNodes };
  }, [tree, mapShowHidden, currentPathIds]);
  const nodeMapLayout = useMemo(
    () => (nodeMapVisibleTree ? buildNodeMapLayout(nodeMapVisibleTree) : null),
    [nodeMapVisibleTree],
  );

  function viewportToCanvas(clientX: number, clientY: number) {
    const viewport = mapViewportRef.current;
    if (!viewport) return { x: 0, y: 0 };
    const rect = viewport.getBoundingClientRect();
    return {
      x: (clientX - rect.left - mapPan.x) / mapScale,
      y: (clientY - rect.top - mapPan.y) / mapScale,
    };
  }

  function onNodeMapPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button")) return;

    if (event.shiftKey) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      const canvasPoint = viewportToCanvas(event.clientX, event.clientY);
      const next: NodeMapMarquee = {
        pointerId: event.pointerId,
        startCanvas: canvasPoint,
        currentCanvas: canvasPoint,
        baseSelection: mapSelectionIds.filter((id) => tree?.nodes[id]),
      };
      mapMarqueeRef.current = next;
      setMapMarquee(next);
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    mapDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: mapPan.x,
      panY: mapPan.y,
      moved: false,
    };
    setMapDragging(true);
  }

  function onNodeMapPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const liveMarquee = mapMarqueeRef.current;
    if (liveMarquee && liveMarquee.pointerId === event.pointerId) {
      const canvasPoint = viewportToCanvas(event.clientX, event.clientY);
      const next = { ...liveMarquee, currentCanvas: canvasPoint };
      mapMarqueeRef.current = next;
      setMapMarquee(next);
      return;
    }

    const drag = mapDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !nodeMapLayout) return;
    const viewport = mapViewportRef.current;
    if (!viewport) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.hypot(dx, dy) > 4) {
      drag.moved = true;
    }
    setMapPan(
      clampNodeMapPan(
        {
          x: drag.panX + dx,
          y: drag.panY + dy,
        },
        nodeMapLayout,
        { width: viewport.clientWidth, height: viewport.clientHeight },
        mapScale,
      ),
    );
  }

  function finishNodeMapDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const liveMarquee = mapMarqueeRef.current;
    if (liveMarquee && liveMarquee.pointerId === event.pointerId) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const intersected = nodesInMarquee(liveMarquee);
      if (intersected.length > 0 || marqueeMoved(liveMarquee)) {
        mapSuppressClickRef.current = true;
        window.setTimeout(() => {
          mapSuppressClickRef.current = false;
        }, 0);
      }
      const merged = [...liveMarquee.baseSelection];
      const seen = new Set(merged);
      for (const id of intersected) {
        if (!seen.has(id)) {
          merged.push(id);
          seen.add(id);
        }
      }
      if (merged.length > 0) {
        setMapSelectionIds(merged);
        if (!seen.has(mapSelectedId ?? "")) {
          setMapSelectedId(merged[merged.length - 1]);
        }
      }
      mapMarqueeRef.current = null;
      setMapMarquee(null);
      return;
    }

    const drag = mapDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      mapSuppressClickRef.current = true;
      window.setTimeout(() => {
        mapSuppressClickRef.current = false;
      }, 0);
    }
    mapDragRef.current = null;
    setMapDragging(false);
  }

  function marqueeRect(marquee: NodeMapMarquee) {
    const x = Math.min(marquee.startCanvas.x, marquee.currentCanvas.x);
    const y = Math.min(marquee.startCanvas.y, marquee.currentCanvas.y);
    const width = Math.abs(marquee.startCanvas.x - marquee.currentCanvas.x);
    const height = Math.abs(marquee.startCanvas.y - marquee.currentCanvas.y);
    return { x, y, width, height };
  }

  function marqueeMoved(marquee: NodeMapMarquee) {
    const rect = marqueeRect(marquee);
    return rect.width > 2 || rect.height > 2;
  }

  function nodesInMarquee(marquee: NodeMapMarquee): string[] {
    if (!nodeMapLayout || !marqueeMoved(marquee)) return [];
    const rect = marqueeRect(marquee);
    const hit: string[] = [];
    for (const item of nodeMapLayout.nodes) {
      if (
        rect.x < item.x + item.width &&
        rect.x + rect.width > item.x &&
        rect.y < item.y + item.height &&
        rect.y + rect.height > item.y
      ) {
        hit.push(item.node.id);
      }
    }
    return hit;
  }

  function zoomNodeMap(factor: number, anchor?: { x: number; y: number }) {
    if (!nodeMapLayout) return;
    const viewport = mapViewportRef.current;
    if (!viewport) return;

    const viewportAnchor = anchor ?? {
      x: viewport.clientWidth / 2,
      y: viewport.clientHeight / 2,
    };
    const nextScale = clampNodeMapScale(mapScale * factor);
    if (nextScale === mapScale) return;

    const canvasX = (viewportAnchor.x - mapPan.x) / mapScale;
    const canvasY = (viewportAnchor.y - mapPan.y) / mapScale;
    const nextPan = clampNodeMapPan(
      {
        x: viewportAnchor.x - canvasX * nextScale,
        y: viewportAnchor.y - canvasY * nextScale,
      },
      nodeMapLayout,
      { width: viewport.clientWidth, height: viewport.clientHeight },
      nextScale,
    );

    setMapScale(nextScale);
    setMapPan(nextPan);
  }

  function onNodeMapWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const viewport = mapViewportRef.current;
    if (!viewport) return;

    const rect = viewport.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
    zoomNodeMap(factor, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  }

  function showMapTooltip(text: string, event: ReactMouseEvent<Element>) {
    const x = Math.min(window.innerWidth - 260, event.clientX + 14);
    const y = Math.min(window.innerHeight - 72, event.clientY + 14);
    setMapTooltip({
      text,
      x: Math.max(8, x),
      y: Math.max(8, y),
    });
  }

  function moveMapTooltip(event: ReactMouseEvent<Element>) {
    setMapTooltip((current) => {
      if (!current) return null;
      const x = Math.min(window.innerWidth - 260, event.clientX + 14);
      const y = Math.min(window.innerHeight - 72, event.clientY + 14);
      return {
        ...current,
        x: Math.max(8, x),
        y: Math.max(8, y),
      };
    });
  }

  function hideMapTooltip() {
    setMapTooltip(null);
  }

  async function onSelectMapNode(
    nodeIdToSelect: string,
    options: { locate?: boolean; extend?: boolean } = {},
  ) {
    setMapSelectedId(nodeIdToSelect);
    setMapSelectionIds((current) => {
      if (!options.extend) return [nodeIdToSelect];
      const validCurrent = current.filter((id) => tree?.nodes[id]);
      if (validCurrent.includes(nodeIdToSelect)) return validCurrent;
      return [...validCurrent, nodeIdToSelect];
    });
    if (options.locate) {
      setMapLocateRequest((value) => value + 1);
    }
  }

  function onNodeMapMinimapPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (!nodeMapLayout) return;
    event.preventDefault();
    event.stopPropagation();

    const viewport = mapViewportRef.current;
    if (!viewport) return;

    const minimapScale = Math.min(
      NODE_MAP_MINIMAP_MAX_WIDTH / nodeMapLayout.width,
      NODE_MAP_MINIMAP_MAX_HEIGHT / nodeMapLayout.height,
    );
    const rect = event.currentTarget.getBoundingClientRect();
    const canvasX = (event.clientX - rect.left) / minimapScale;
    const canvasY = (event.clientY - rect.top) / minimapScale;

    setMapPan(
      clampNodeMapPan(
        {
          x: Math.round(viewport.clientWidth / 2 - canvasX * mapScale),
          y: Math.round(viewport.clientHeight / 2 - canvasY * mapScale),
        },
        nodeMapLayout,
        { width: viewport.clientWidth, height: viewport.clientHeight },
        mapScale,
      ),
    );
  }

  // Center the selected (or current) node when a locate is requested.
  useEffect(() => {
    if (!nodeMapLayout || !currentId || mapLocateRequest === 0) {
      return;
    }
    if (lastHandledLocateRequestRef.current === mapLocateRequest) {
      return;
    }
    lastHandledLocateRequestRef.current = mapLocateRequest;

    const viewport = mapViewportRef.current;
    const targetId =
      mapSelectedId && tree?.nodes[mapSelectedId] ? mapSelectedId : currentId;
    const item = nodeMapLayout.nodes.find(
      (candidate) => candidate.node.id === targetId,
    );
    if (!viewport || !item) return;
    const scale = mapScale;

    setMapPan(
      clampNodeMapPan(
        {
          x: Math.round(viewport.clientWidth / 2 - (item.x + item.width / 2) * scale),
          y: Math.round(
            Math.min(
              96,
              viewport.clientHeight / 2 - (item.y + item.height / 2) * scale,
            ),
          ),
        },
        nodeMapLayout,
        { width: viewport.clientWidth, height: viewport.clientHeight },
        scale,
      ),
    );
  }, [currentId, mapLocateRequest, mapScale, mapSelectedId, nodeMapLayout, tree]);

  // Track the viewport size so the minimap viewport rectangle stays accurate.
  useEffect(() => {
    const viewport = mapViewportRef.current;
    if (!viewport) return;
    const observedViewport = viewport;

    function updateViewportSize() {
      const nextWidth = Math.round(observedViewport.clientWidth);
      const nextHeight = Math.round(observedViewport.clientHeight);
      setMapViewportSize((current) =>
        current.width === nextWidth && current.height === nextHeight
          ? current
          : { width: nextWidth, height: nextHeight },
      );
    }

    updateViewportSize();
    const resizeObserver = new ResizeObserver(updateViewportSize);
    resizeObserver.observe(observedViewport);
    return () => resizeObserver.disconnect();
  }, []);

  // Fit the whole tree into view when a fit is requested.
  useEffect(() => {
    if (!nodeMapLayout || mapFitRequest === 0) {
      return;
    }
    if (lastHandledFitRequestRef.current === mapFitRequest) {
      return;
    }
    lastHandledFitRequestRef.current = mapFitRequest;

    const viewport = mapViewportRef.current;
    if (!viewport) return;

    const availableWidth = Math.max(1, viewport.clientWidth - NODE_MAP_FIT_PADDING * 2);
    const availableHeight = Math.max(
      1,
      viewport.clientHeight - NODE_MAP_FIT_PADDING * 2,
    );
    const scale = clampNodeMapScale(
      Math.min(
        1,
        availableWidth / nodeMapLayout.width,
        availableHeight / nodeMapLayout.height,
      ),
    );

    setMapScale(scale);
    setMapPan(
      clampNodeMapPan(
        {
          x: Math.round((viewport.clientWidth - nodeMapLayout.width * scale) / 2),
          y: Math.round((viewport.clientHeight - nodeMapLayout.height * scale) / 2),
        },
        nodeMapLayout,
        { width: viewport.clientWidth, height: viewport.clientHeight },
        scale,
      ),
    );
  }, [mapFitRequest, nodeMapLayout]);

  // Fit on first mount so the tree is framed when the map opens.
  useEffect(() => {
    setMapFitRequest((value) => value + 1);
  }, []);

  // Map zoom/fit keyboard shortcuts. Registered once; zoomNodeMap read via ref.
  const zoomNodeMapRef = useLatestRef(zoomNodeMap);
  useEffect(() => {
    function onMapKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "0") {
        event.preventDefault();
        setMapFitRequest((value) => value + 1);
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomNodeMapRef.current(1.12);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomNodeMapRef.current(1 / 1.12);
      }
    }
    window.addEventListener("keydown", onMapKeyDown);
    return () => window.removeEventListener("keydown", onMapKeyDown);
  }, [zoomNodeMapRef]);

  // cmd/ctrl+Z restores the most recent map delete. onUndoLastDelete no-ops when
  // there is nothing to restore.
  const onUndoLastDeleteRef = useLatestRef(onUndoLastDelete);
  useEffect(() => {
    function onUndoKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (event.key !== "z" && event.key !== "Z") return;
      event.preventDefault();
      void onUndoLastDeleteRef.current();
    }
    window.addEventListener("keydown", onUndoKeyDown);
    return () => window.removeEventListener("keydown", onUndoKeyDown);
  }, [onUndoLastDeleteRef]);

  if (!tree || !currentId || !currentNode || !nodeMapLayout) return null;

  const validMapSelectionIds = mapSelectionIds.filter((id) => tree.nodes[id]);
  const resolvedSelectionIds =
    validMapSelectionIds.length > 0 ? validMapSelectionIds : [currentId];
  const marqueePreviewIds = mapMarquee ? nodesInMarquee(mapMarquee) : [];
  const previewSelectionIds = mapMarquee
    ? Array.from(new Set([...mapMarquee.baseSelection, ...marqueePreviewIds]))
    : resolvedSelectionIds;
  const selectionSet = new Set(previewSelectionIds);
  const multiSelectionEligibleIds = validMapSelectionIds.filter(
    (id) => tree.nodes[id]?.parentId !== null,
  );
  const multiSelectionDeleteIds = multiSelectionEligibleIds;
  const multiSelectionHideIds = multiSelectionEligibleIds.filter((id) => {
    const node = tree.nodes[id];
    return node && (node.hidden || id !== currentId);
  });
  const canMultiDelete =
    validMapSelectionIds.length >= 2 &&
    multiSelectionDeleteIds.length === validMapSelectionIds.length &&
    !(saving || streaming);
  const canMultiHide =
    validMapSelectionIds.length >= 2 &&
    multiSelectionHideIds.length === validMapSelectionIds.length &&
    !(saving || streaming);
  const selectedNode =
    mapSelectedId && tree.nodes[mapSelectedId]
      ? tree.nodes[mapSelectedId]
      : currentNode;

  const childNodes = childrenOf(tree, selectedNode.id);
  const parentNode = selectedNode.parentId ? tree.nodes[selectedNode.parentId] : null;
  const parentChildCount = parentNode ? childrenOf(tree, parentNode.id).length : 0;
  const actionDisabled = saving || streaming;
  const canDelete = selectedNode.parentId !== null && !actionDisabled;
  const canHide =
    selectedNode.parentId !== null &&
    (selectedNode.hidden || selectedNode.id !== currentId) &&
    !actionDisabled;
  const canMergeUp =
    selectedNode.parentId !== null &&
    parentNode !== null &&
    parentNode.parentId !== null &&
    parentChildCount === 1 &&
    !actionDisabled;
  const canMergeDown =
    selectedNode.parentId !== null && childNodes.length === 1 && !actionDisabled;
  const linearChainDownIds = collectLinearChainDownward(tree, selectedNode.id);
  const canMergeChainDown =
    selectedNode.parentId !== null && linearChainDownIds.length >= 2 && !actionDisabled;
  const mergeSelectionAnalysis = analyzeNodeMapMergeSelection(
    tree,
    resolvedSelectionIds,
  );
  const canMergeSelection = mergeSelectionAnalysis.ok && !actionDisabled;
  const mergeSelectionHint = mergeSelectionAnalysis.ok
    ? "Merge selected nodes"
    : mergeSelectionAnalysis.reason;
  const starredNodes = Object.values(tree.nodes)
    .filter((node) => node.starred)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const mapScaleLabel = `${Math.round(mapScale * 100)}%`;
  const minimapScale = Math.min(
    NODE_MAP_MINIMAP_MAX_WIDTH / nodeMapLayout.width,
    NODE_MAP_MINIMAP_MAX_HEIGHT / nodeMapLayout.height,
  );
  const minimapWidth = Math.max(1, Math.round(nodeMapLayout.width * minimapScale));
  const minimapHeight = Math.max(1, Math.round(nodeMapLayout.height * minimapScale));
  const liveViewportWidth =
    mapViewportSize.width || mapViewportRef.current?.clientWidth || 1;
  const liveViewportHeight =
    mapViewportSize.height || mapViewportRef.current?.clientHeight || 1;
  const viewportRect = {
    x: clampNumber((-mapPan.x / mapScale) * minimapScale, 0, minimapWidth),
    y: clampNumber((-mapPan.y / mapScale) * minimapScale, 0, minimapHeight),
    width: clampNumber((liveViewportWidth / mapScale) * minimapScale, 1, minimapWidth),
    height: clampNumber(
      (liveViewportHeight / mapScale) * minimapScale,
      1,
      minimapHeight,
    ),
  };

  return (
    <section className="bw-node-map-shell" aria-label="Node map">
      <div className="bw-node-map-head">
        <div>
          <div className="bw-kicker">Node Map</div>
          <div className="bw-node-map-summary">
            {nodeMapLayout.nodes.length.toLocaleString()} of{" "}
            {Object.keys(tree.nodes).length.toLocaleString()} nodes shown ·{" "}
            {mapScaleLabel} · drag to pan, shift-drag to box-select
          </div>
        </div>
        <div className="bw-node-map-controls" aria-label="Map view controls">
          <button
            type="button"
            className="bw-button"
            title="Fit the whole tree (Cmd+0)"
            onMouseEnter={(event) =>
              showMapTooltip("Fit the entire node tree in the map.", event)
            }
            onMouseMove={moveMapTooltip}
            onMouseLeave={hideMapTooltip}
            onClick={() => setMapFitRequest((value) => value + 1)}
          >
            Fit all
          </button>
          <button
            type="button"
            className="bw-button bw-node-map-zoom-button"
            title="Zoom out (Cmd+-)"
            onMouseEnter={(event) => showMapTooltip("Zoom out.", event)}
            onMouseMove={moveMapTooltip}
            onMouseLeave={hideMapTooltip}
            onClick={() => zoomNodeMap(1 / 1.12)}
            aria-label="Zoom out"
          >
            -
          </button>
          <button
            type="button"
            className="bw-button bw-node-map-zoom-button"
            title="Zoom in (Cmd++)"
            onMouseEnter={(event) => showMapTooltip("Zoom in.", event)}
            onMouseMove={moveMapTooltip}
            onMouseLeave={hideMapTooltip}
            onClick={() => zoomNodeMap(1.12)}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            type="button"
            className="bw-button"
            title="Center the selected node"
            onMouseEnter={(event) =>
              showMapTooltip("Center the selected node in the map.", event)
            }
            onMouseMove={moveMapTooltip}
            onMouseLeave={hideMapTooltip}
            onClick={() => setMapLocateRequest((value) => value + 1)}
          >
            Locate selected
          </button>
          <label className="bw-node-map-toggle">
            <input
              type="checkbox"
              checked={mapShowHidden}
              onChange={(event) => {
                setMapShowHidden(event.target.checked);
                setMapFitRequest((value) => value + 1);
              }}
            />
            Show hidden
          </label>
        </div>
      </div>
      <div className="bw-node-map-body">
        <div
          ref={mapViewportRef}
          className="bw-node-map-viewport"
          data-dragging={mapDragging}
          onPointerDown={onNodeMapPointerDown}
          onPointerMove={onNodeMapPointerMove}
          onPointerUp={finishNodeMapDrag}
          onPointerCancel={finishNodeMapDrag}
          onWheel={onNodeMapWheel}
        >
          <div
            className="bw-node-map-canvas"
            style={{
              width: nodeMapLayout.width,
              height: nodeMapLayout.height,
              transform: `translate(${mapPan.x}px, ${mapPan.y}px) scale(${mapScale})`,
            }}
          >
            <svg
              className="bw-node-map-edges"
              viewBox={`0 0 ${nodeMapLayout.width} ${nodeMapLayout.height}`}
              aria-hidden="true"
            >
              {nodeMapLayout.edges.map((edge) => {
                const parent = tree.nodes[edge.parentId];
                const child = tree.nodes[edge.childId];
                const active =
                  currentPathIds.has(edge.parentId) && currentPathIds.has(edge.childId);
                const midY = edge.fromY + Math.max(42, (edge.toY - edge.fromY) * 0.48);
                return (
                  <path
                    key={`${edge.parentId}-${edge.childId}`}
                    className="bw-node-map-edge"
                    data-path={active}
                    data-hidden={child?.hidden ?? false}
                    d={`M ${edge.fromX} ${edge.fromY} C ${edge.fromX} ${midY}, ${edge.toX} ${midY}, ${edge.toX} ${edge.toY}`}
                    onMouseEnter={(event) =>
                      showMapTooltip(
                        `${parent ? nodeLabel(parent) : "missing parent"} -> ${child ? nodeLabel(child) : "missing child"}`,
                        event,
                      )
                    }
                    onMouseMove={moveMapTooltip}
                    onMouseLeave={hideMapTooltip}
                  />
                );
              })}
            </svg>
            {nodeMapLayout.nodes.map((item) => {
              const node = item.node;
              const isCurrent = node.id === currentId;
              const isSelected = selectionSet.has(node.id);
              const isPrimarySelected = node.id === selectedNode.id;
              const isOnPath = currentPathIds.has(node.id);
              const nodeChildren = childrenOf(tree, node.id);
              return (
                <button
                  key={node.id}
                  type="button"
                  className="bw-node-map-node"
                  data-current={isCurrent}
                  data-selected={isSelected}
                  data-primary={isPrimarySelected}
                  data-path={isOnPath}
                  data-hidden={node.hidden}
                  data-starred={node.starred}
                  style={{
                    left: item.x,
                    top: item.y,
                    width: item.width,
                    height: item.height,
                  }}
                  onClick={(event) => {
                    if (mapSuppressClickRef.current) return;
                    if (event.detail >= 2) {
                      event.preventDefault();
                      event.stopPropagation();
                      setWorkspaceMode("compose");
                      void onSelectNode(node.id);
                      return;
                    }
                    void onSelectMapNode(node.id, { extend: event.shiftKey });
                  }}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setWorkspaceMode("compose");
                    void onSelectNode(node.id);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openTreeMenu(node.id, event.clientX, event.clientY);
                  }}
                  onMouseEnter={(event) =>
                    showMapTooltip(
                      `${nodeLabel(node)} · click to select, shift-click to add, double-click to open`,
                      event,
                    )
                  }
                  onMouseMove={moveMapTooltip}
                  onMouseLeave={hideMapTooltip}
                  disabled={actionDisabled}
                  title={`Select ${nodeLabel(node)}. Double-click to open in Compose.`}
                >
                  <span className="bw-node-map-node-title">
                    {node.starred && <span aria-hidden="true">★</span>}
                    {nodeLabel(node)}
                  </span>
                  <span className="bw-node-map-node-meta">
                    {node.source.replace("_", " ")}
                    {nodeChildren.length > 0
                      ? ` · ${nodeChildren.length} child${
                          nodeChildren.length === 1 ? "" : "ren"
                        }`
                      : ""}
                    {node.hidden ? " · hidden" : ""}
                  </span>
                </button>
              );
            })}
            {mapMarquee &&
              (() => {
                const rect = marqueeRect(mapMarquee);
                return (
                  <div
                    className="bw-node-map-marquee"
                    style={{
                      left: rect.x,
                      top: rect.y,
                      width: rect.width,
                      height: rect.height,
                    }}
                    aria-hidden="true"
                  />
                );
              })()}
          </div>
          {mapTooltip && (
            <div
              className="bw-node-map-tooltip"
              style={{ left: mapTooltip.x, top: mapTooltip.y }}
              role="tooltip"
            >
              {mapTooltip.text}
            </div>
          )}
        </div>
        <aside className="bw-node-map-inspector" aria-label="Selected node">
          <div className="bw-node-map-inspector-head">
            <div className="bw-kicker">Selected</div>
            <div className="bw-node-map-current">{nodeLabel(selectedNode)}</div>
            <div className="bw-node-map-current-meta">
              {selectedNode.source.replace("_", " ")} · {childNodes.length} child
              {childNodes.length === 1 ? "" : "ren"}
              {selectedNode.hidden ? " · hidden" : ""}
              {resolvedSelectionIds.length > 1
                ? ` · ${resolvedSelectionIds.length} selected`
                : ""}
            </div>
          </div>
          <div className="bw-node-map-starred">
            <div className="bw-node-map-section-title">
              <span>Starred</span>
              <span>{starredNodes.length}</span>
            </div>
            {starredNodes.length > 0 ? (
              <div className="bw-node-map-starred-list">
                {starredNodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    className="bw-node-map-starred-item"
                    data-current={node.id === selectedNode.id}
                    data-hidden={node.hidden}
                    onClick={() => void onSelectMapNode(node.id, { locate: true })}
                    onMouseEnter={(event) =>
                      showMapTooltip(`Jump to ${nodeLabel(node)}.`, event)
                    }
                    onMouseMove={moveMapTooltip}
                    onMouseLeave={hideMapTooltip}
                    disabled={actionDisabled || node.id === selectedNode.id}
                    title={`Jump to ${nodeLabel(node)}`}
                  >
                    <span>{nodeLabel(node)}</span>
                    {node.hidden && <small>hidden</small>}
                  </button>
                ))}
              </div>
            ) : (
              <div className="bw-node-map-empty-starred">
                Star nodes to make them available here.
              </div>
            )}
          </div>
          <div className="bw-node-map-actions">
            {(() => {
              const renderActionButton = (props: {
                label: string;
                onClick: () => void;
                disabled: boolean;
                tooltip: string;
                wide?: boolean;
                danger?: boolean;
              }) => (
                <span
                  className={`bw-node-map-action-cell${
                    props.wide ? " bw-node-map-action-wide" : ""
                  }`}
                  onMouseEnter={(event) => showMapTooltip(props.tooltip, event)}
                  onMouseMove={moveMapTooltip}
                  onMouseLeave={hideMapTooltip}
                >
                  <button
                    type="button"
                    className={`bw-button${props.danger ? " bw-button-danger" : ""}`}
                    onClick={props.onClick}
                    disabled={props.disabled}
                    title={props.tooltip}
                  >
                    {props.label}
                  </button>
                </span>
              );

              const hideTooltip =
                selectedNode.parentId === null
                  ? "Root cannot be hidden."
                  : selectedNode.id === currentId && !selectedNode.hidden
                    ? "Select another node before hiding this active node."
                    : selectedNode.hidden
                      ? "Unhide this node so it shows up in normal tree views again."
                      : "Hide this node from normal tree views (it stays in the file as a sibling branch).";

              const mergeUpTooltip = canMergeUp
                ? "Fold the selected node up into its parent. The parent absorbs this node's text; this node disappears."
                : selectedNode.parentId === null
                  ? "Root has no parent to merge into."
                  : parentNode?.parentId === null
                    ? "The parent is root, which can't be folded into."
                    : parentChildCount !== 1
                      ? "The parent has more than one child, so merging would lose the sibling branches."
                      : "Cannot merge up right now.";

              const mergeDownTooltip = canMergeDown
                ? "Fold the selected node's only child into this node. This node absorbs the child's text; the child disappears."
                : selectedNode.parentId === null
                  ? "Root cannot be merged."
                  : childNodes.length === 0
                    ? "This node has no child to merge with."
                    : "This node has more than one child — pick a single-child node, or use Merge selection to pick a chain manually.";

              const mergeChainTooltip = canMergeChainDown
                ? `Walk down through ${linearChainDownIds.length - 1} consecutive single-child descendant${linearChainDownIds.length === 2 ? "" : "s"} and collapse the whole run (${linearChainDownIds.length} nodes) into this one.`
                : selectedNode.parentId === null
                  ? "Root cannot be merged."
                  : childNodes.length === 0
                    ? "This node has no descendants to fold in."
                    : childNodes.length > 1
                      ? "This node already branches — there's no single-child chain to collapse."
                      : "No single-child chain to collapse.";

              const deleteTooltip = canDelete
                ? "Delete this node and every descendant beneath it. Press cmd/ctrl+Z to restore."
                : "Root cannot be deleted.";

              const mergeSelectionTooltip = canMergeSelection
                ? `Combine the ${resolvedSelectionIds.length} shift-selected nodes (a parent → child run) into a single node.`
                : mergeSelectionHint;

              const hideSelectionTooltip = canMultiHide
                ? `Hide all ${multiSelectionHideIds.length} selected nodes from normal tree views.`
                : validMapSelectionIds.length < 2
                  ? "Shift-click or shift-drag to select at least two nodes."
                  : "Selection includes the root or the active node, which can't be hidden. Drop those from the selection first.";

              const deleteSelectionTooltip = canMultiDelete
                ? `Delete all ${multiSelectionDeleteIds.length} selected nodes and their descendants. Press cmd/ctrl+Z to restore.`
                : validMapSelectionIds.length < 2
                  ? "Shift-click or shift-drag to select at least two nodes."
                  : "Selection includes the root, which can't be deleted. Drop the root from the selection first.";

              return (
                <>
                  {renderActionButton({
                    label: selectedNode.starred ? "Unstar" : "Star",
                    onClick: () =>
                      void onSetNodeStarred(selectedNode.id, !selectedNode.starred),
                    disabled: actionDisabled,
                    tooltip: selectedNode.starred
                      ? "Remove this node from the starred shortcut list."
                      : "Pin this node to the starred shortcut list for quick navigation.",
                  })}
                  {renderActionButton({
                    label: selectedNode.hidden ? "Unhide" : "Hide",
                    onClick: () =>
                      void onSetNodeHidden(selectedNode.id, !selectedNode.hidden),
                    disabled: !canHide,
                    tooltip: hideTooltip,
                  })}
                  {renderActionButton({
                    label: "Merge up",
                    onClick: () => void onMergeNodeIntoParent(selectedNode.id),
                    disabled: !canMergeUp,
                    tooltip: mergeUpTooltip,
                  })}
                  {renderActionButton({
                    label: "Merge down",
                    onClick: () => void onMergeNodeWithOnlyChild(selectedNode.id),
                    disabled: !canMergeDown,
                    tooltip: mergeDownTooltip,
                  })}
                  {renderActionButton({
                    label: "Merge chain",
                    onClick: () => void onMergeLinearChainDown(selectedNode.id),
                    disabled: !canMergeChainDown,
                    tooltip: mergeChainTooltip,
                  })}
                  {renderActionButton({
                    label: "Delete",
                    onClick: () => void onDeleteMapNode(selectedNode.id),
                    disabled: !canDelete,
                    tooltip: deleteTooltip,
                    danger: true,
                  })}
                  {renderActionButton({
                    label: "Merge selection",
                    onClick: () => void onMergeMapSelection(resolvedSelectionIds),
                    disabled: !canMergeSelection,
                    tooltip: mergeSelectionTooltip,
                    wide: true,
                  })}
                  {renderActionButton({
                    label: "Hide selection",
                    onClick: () => void onHideMapSelection(multiSelectionHideIds),
                    disabled: !canMultiHide,
                    tooltip: hideSelectionTooltip,
                    wide: true,
                  })}
                  {renderActionButton({
                    label: "Delete selection",
                    onClick: () => void onDeleteMapSelection(multiSelectionDeleteIds),
                    disabled: !canMultiDelete,
                    tooltip: deleteSelectionTooltip,
                    wide: true,
                    danger: true,
                  })}
                </>
              );
            })()}
          </div>
          <div className="bw-node-map-merge-note">
            Shift-click a node to add it to the selection, or shift-drag a box across
            the canvas to select everything inside it. Merge is blocked whenever the
            upstream node has more than one child.
          </div>
          <div className="bw-node-map-minimap" aria-label="Node map minimap">
            <div className="bw-node-map-section-title">
              <span>Minimap</span>
            </div>
            <svg
              width={minimapWidth}
              height={minimapHeight}
              viewBox={`0 0 ${minimapWidth} ${minimapHeight}`}
              onPointerDown={onNodeMapMinimapPointerDown}
              onMouseEnter={(event) =>
                showMapTooltip("Minimap. Click to jump the viewport.", event)
              }
              onMouseMove={moveMapTooltip}
              onMouseLeave={hideMapTooltip}
            >
              {nodeMapLayout.edges.map((edge) => (
                <line
                  key={`${edge.parentId}-${edge.childId}-mini`}
                  x1={edge.fromX * minimapScale}
                  y1={edge.fromY * minimapScale}
                  x2={edge.toX * minimapScale}
                  y2={edge.toY * minimapScale}
                />
              ))}
              {nodeMapLayout.nodes.map((item) => (
                <rect
                  key={`${item.node.id}-mini`}
                  x={item.x * minimapScale}
                  y={item.y * minimapScale}
                  width={Math.max(2, item.width * minimapScale)}
                  height={Math.max(2, item.height * minimapScale)}
                  data-current={item.node.id === currentId}
                  data-selected={selectionSet.has(item.node.id)}
                />
              ))}
              <rect
                className="bw-node-map-minimap-view"
                x={viewportRect.x}
                y={viewportRect.y}
                width={viewportRect.width}
                height={viewportRect.height}
              />
            </svg>
          </div>
        </aside>
      </div>
    </section>
  );
}
