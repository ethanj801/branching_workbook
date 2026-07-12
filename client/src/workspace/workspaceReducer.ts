import type { SetStateAction } from "react";

import type { ProjectInfo } from "../api";
import type { Tree } from "../tree/types";

/**
 * The core workspace document state: the open project plus the active path
 * (tree / currentId / buffer), the node-map selection, and the async flags
 * (saving / streaming / error) that bracket every persistence round-trip.
 *
 * These ten fields move together. Loading a project sets four of them at once;
 * persisting an edit relocates the path and the map selection in a single beat.
 * Holding them in one reducer makes those coupled transitions atomic and
 * unit-testable instead of a scatter of individual setters in App.
 *
 * Deliberately NOT here: pure map-*view* state (scale, pan, show-hidden, the
 * fit request), the writing mode, tree-view collapse state, autocomplete, and
 * the candidate/chat-draft slices — those change independently and live in
 * their own `useState`s / hooks.
 */
export type WorkspaceState = {
  project: ProjectInfo | null;
  tree: Tree | null;
  currentId: string | null;
  buffer: string;
  mapSelectedId: string | null;
  mapSelectionIds: string[];
  mapLocateRequest: number;
  streaming: boolean;
  saving: boolean;
  error: string | null;
};

export const initialWorkspaceState: WorkspaceState = {
  project: null,
  tree: null,
  currentId: null,
  buffer: "",
  mapSelectedId: null,
  mapSelectionIds: [],
  mapLocateRequest: 0,
  streaming: false,
  saving: false,
  error: null,
};

export type WorkspaceAction =
  // Per-field updates. These back the wrapper setters App still hands to
  // NodeMapView, the editor, and useModelLoader, so they carry a full
  // SetStateAction to preserve the functional-updater forms those callers use
  // (e.g. `setMapLocateRequest((v) => v + 1)`). project, tree, and currentId
  // have no per-field setter — they only ever change via the semantic
  // transitions below.
  | { type: "setBuffer"; value: SetStateAction<string> }
  | { type: "setMapSelectedId"; value: SetStateAction<string | null> }
  | { type: "setMapSelectionIds"; value: SetStateAction<string[]> }
  | { type: "setMapLocateRequest"; value: SetStateAction<number> }
  | { type: "setStreaming"; value: SetStateAction<boolean> }
  | { type: "setSaving"; value: SetStateAction<boolean> }
  | { type: "setError"; value: SetStateAction<string | null> }
  // Semantic, coupled transitions — one dispatch per logical action.
  | {
      type: "projectLoaded";
      project: ProjectInfo;
      tree: Tree;
      currentId: string;
      buffer: string;
    }
  | { type: "projectClosed" }
  | { type: "bufferReshaped"; tree: Tree; currentId: string; buffer: string }
  | { type: "nodeSelected"; tree: Tree; currentId: string; buffer: string }
  | {
      type: "editPersisted";
      tree: Tree;
      currentId: string;
      buffer: string;
      selectedId: string;
      selectedIds?: string[];
    }
  | { type: "treeMutated"; tree: Tree };

function applyUpdate<T>(update: SetStateAction<T>, prev: T): T {
  return typeof update === "function" ? (update as (prev: T) => T)(prev) : update;
}

export function workspaceReducer(
  state: WorkspaceState,
  action: WorkspaceAction,
): WorkspaceState {
  switch (action.type) {
    case "setBuffer":
      return { ...state, buffer: applyUpdate(action.value, state.buffer) };
    case "setMapSelectedId":
      return {
        ...state,
        mapSelectedId: applyUpdate(action.value, state.mapSelectedId),
      };
    case "setMapSelectionIds":
      return {
        ...state,
        mapSelectionIds: applyUpdate(action.value, state.mapSelectionIds),
      };
    case "setMapLocateRequest":
      return {
        ...state,
        mapLocateRequest: applyUpdate(action.value, state.mapLocateRequest),
      };
    case "setStreaming":
      return { ...state, streaming: applyUpdate(action.value, state.streaming) };
    case "setSaving":
      return { ...state, saving: applyUpdate(action.value, state.saving) };
    case "setError":
      return { ...state, error: applyUpdate(action.value, state.error) };

    case "projectLoaded":
      return {
        ...state,
        project: action.project,
        tree: action.tree,
        currentId: action.currentId,
        buffer: action.buffer,
      };
    case "projectClosed":
      return { ...state, project: null, tree: null, currentId: null, buffer: "" };
    case "bufferReshaped":
      return {
        ...state,
        tree: action.tree,
        currentId: action.currentId,
        buffer: action.buffer,
      };
    case "nodeSelected":
      return {
        ...state,
        tree: action.tree,
        currentId: action.currentId,
        buffer: action.buffer,
      };
    case "editPersisted":
      return {
        ...state,
        tree: action.tree,
        currentId: action.currentId,
        buffer: action.buffer,
        mapSelectedId: action.selectedId,
        mapSelectionIds: action.selectedIds ?? [action.selectedId],
        mapLocateRequest: state.mapLocateRequest + 1,
      };
    case "treeMutated":
      return { ...state, tree: action.tree };
  }
}
