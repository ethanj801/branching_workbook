import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder as editorPlaceholder,
  type DecorationSet,
  type KeyBinding,
  type ViewUpdate,
} from "@codemirror/view";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

export type EditorSelection = {
  start: number;
  end: number;
};

export type WorkbookEditorHandle = {
  focus: () => void;
  setSelectionRange: (start: number, end: number) => void;
  getSelection: () => EditorSelection;
};

type WorkbookEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onSelectionChange?: (selection: EditorSelection) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  disabled?: boolean;
  placeholder?: string;
  ghostText?: string | null;
  keyBindings?: readonly KeyBinding[];
};

class GhostWidget extends WidgetType {
  readonly text: string;

  constructor(text: string) {
    super();
    this.text = text;
  }

  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "bw-editor-ghost";
    span.textContent = this.text;
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function ghostExtension(text: string | null | undefined): Extension {
  if (!text) return [];
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.build(update.view);
        }
      }

      build(view: EditorView): DecorationSet {
        return Decoration.set([
          Decoration.widget({
            widget: new GhostWidget(text),
            side: 1,
          }).range(view.state.doc.length),
        ]);
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
    },
  );
}

function selectionFromView(view: EditorView): EditorSelection {
  const range = view.state.selection.main;
  return {
    start: Math.min(range.from, range.to),
    end: Math.max(range.from, range.to),
  };
}

const editorBaseTheme = EditorView.theme({
  "&": {
    background: "transparent",
    color: "var(--ink)",
    fontFamily: "Iowan Old Style, Palatino Linotype, Palatino, Georgia, serif",
    fontSize: "clamp(1.08rem, 0.72rem + 0.42vw, 1.26rem)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-scroller": {
    overflow: "visible",
    fontFamily: "inherit",
    lineHeight: "1.68",
  },
  ".cm-content": {
    minHeight: "min(34rem, calc(100vh - 18rem))",
    padding: "0",
    caretColor: "var(--ink)",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-placeholder": {
    color: "rgba(117, 107, 92, 0.48)",
    fontStyle: "italic",
  },
  ".cm-selectionBackground": {
    background: "rgba(63, 85, 102, 0.2) !important",
  },
});

const disabledTheme = EditorView.theme({
  "&": {
    opacity: "0.72",
  },
});

const defaultEditorExtensions = [
  history(),
  EditorView.lineWrapping,
  keymap.of([...historyKeymap, ...defaultKeymap]),
  editorBaseTheme,
];

const WorkbookEditor = forwardRef<WorkbookEditorHandle, WorkbookEditorProps>(
  function WorkbookEditor(
    {
      value,
      onChange,
      onSelectionChange,
      onFocus,
      onBlur,
      disabled = false,
      placeholder = "",
      ghostText = null,
      keyBindings = [],
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const onSelectionChangeRef = useRef(onSelectionChange);
    const onFocusRef = useRef(onFocus);
    const onBlurRef = useRef(onBlur);
    const disabledCompartment = useRef(new Compartment());
    const placeholderCompartment = useRef(new Compartment());
    const keymapCompartment = useRef(new Compartment());
    const ghostCompartment = useRef(new Compartment());

    onChangeRef.current = onChange;
    onSelectionChangeRef.current = onSelectionChange;
    onFocusRef.current = onFocus;
    onBlurRef.current = onBlur;

    useImperativeHandle(ref, () => ({
      focus: () => viewRef.current?.focus(),
      setSelectionRange: (start: number, end: number) => {
        const view = viewRef.current;
        if (!view) return;
        const docLength = view.state.doc.length;
        const anchor = Math.max(0, Math.min(docLength, start));
        const head = Math.max(0, Math.min(docLength, end));
        view.dispatch({
          selection: { anchor, head },
          scrollIntoView: true,
        });
        view.focus();
      },
      getSelection: () =>
        viewRef.current
          ? selectionFromView(viewRef.current)
          : { start: value.length, end: value.length },
    }));

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      const view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: value,
          extensions: [
            ...defaultEditorExtensions,
            placeholderCompartment.current.of(
              placeholder ? editorPlaceholder(placeholder) : [],
            ),
            disabledCompartment.current.of([
              EditorView.editable.of(!disabled),
              EditorState.readOnly.of(disabled),
              disabled ? disabledTheme : [],
            ]),
            keymapCompartment.current.of(
              keyBindings.length > 0
                ? Prec.highest(keymap.of([...keyBindings]))
                : [],
            ),
            ghostCompartment.current.of(ghostExtension(ghostText)),
            EditorView.domEventHandlers({
              focus: () => {
                onFocusRef.current?.();
              },
              blur: () => {
                onBlurRef.current?.();
              },
            }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                onChangeRef.current(update.state.doc.toString());
              }
              if (update.docChanged || update.selectionSet) {
                onSelectionChangeRef.current?.(selectionFromView(update.view));
              }
            }),
          ],
        }),
      });

      viewRef.current = view;
      onSelectionChangeRef.current?.(selectionFromView(view));

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // Mount once; live props are synchronized through refs/compartments.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === value) return;
      const head = Math.min(view.state.selection.main.head, value.length);
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
        selection: { anchor: head },
      });
    }, [value]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: placeholderCompartment.current.reconfigure(
          placeholder ? editorPlaceholder(placeholder) : [],
        ),
      });
    }, [placeholder]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: disabledCompartment.current.reconfigure([
          EditorView.editable.of(!disabled),
          EditorState.readOnly.of(disabled),
          disabled ? disabledTheme : [],
        ]),
      });
    }, [disabled]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: keymapCompartment.current.reconfigure(
          keyBindings.length > 0
            ? Prec.highest(keymap.of([...keyBindings]))
            : [],
        ),
      });
    }, [keyBindings]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: ghostCompartment.current.reconfigure(ghostExtension(ghostText)),
      });
    }, [ghostText]);

    return <div ref={hostRef} className="bw-buffer bw-cm-editor" />;
  },
);

export default WorkbookEditor;
