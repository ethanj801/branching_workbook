import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type TextareaHTMLAttributes,
} from "react";

// The chat textareas style themselves with CSS `field-sizing: content` to grow
// with their content. That property also reflows the box when its column width
// changes (e.g. the sidebar collapses and the transcript widens), so where the
// browser supports it the CSS alone is correct and this component renders a
// plain textarea.
//
// field-sizing landed in Chrome 123 (Mar 2024) and Safari 18 (Sept 2024), and
// Firefox still lacks it as of mid-2026. There we set the height from
// scrollHeight ourselves, on both value changes and width changes. We must not
// do this where field-sizing works, because an inline height overrides
// field-sizing and freezes the box at whatever width it was last measured at,
// leaving empty space below the text after the column resizes.
const supportsFieldSizing =
  typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");

export default function AutoGrowTextarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  const { onKeyDown, ...textareaProps } = props;
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Cmd+Up / Cmd+Down natively move the caret to the start or end of the
  // textarea, but a grown box has no internal scroll, so the transcript
  // pane never follows and the jump looks like a no-op. Once the caret
  // lands, bring the box edge it moved to into view.
  const followCaretEdge = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (!event.metaKey || event.altKey || event.ctrlKey) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const ta = event.currentTarget;
      const toStart = event.key === "ArrowUp";
      requestAnimationFrame(() => {
        let scroller: HTMLElement | null = ta.parentElement;
        while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
          scroller = scroller.parentElement;
        }
        if (!scroller) return;
        const box = ta.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        // Roughly one line of slack so "visible" means the caret line
        // is actually readable, and no scroll happens when it is.
        const margin = 32;
        if (toStart) {
          if (box.top < view.top || box.top > view.bottom - margin) {
            ta.scrollIntoView({ block: "start" });
          }
        } else if (box.bottom > view.bottom || box.bottom < view.top + margin) {
          ta.scrollIntoView({ block: "end" });
        }
      });
    },
    [],
  );

  const resize = useCallback(() => {
    const ta = ref.current;
    if (!ta) return;
    // height:auto momentarily collapses the textarea to its CSS min-height
    // during the re-measure's forced reflow. If a long textarea sits inside a
    // scrolled container (the chat transcript), that collapse shrinks the
    // container's content and the browser clamps its scrollTop permanently,
    // since restoring the height afterwards doesn't restore the scroll. Pin the
    // nearest scrollable ancestor across the two writes.
    let scroller: HTMLElement | null = ta.parentElement;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
      scroller = scroller.parentElement;
    }
    const scrollTopBefore = scroller?.scrollTop;
    ta.style.height = "auto";
    // scrollHeight excludes the borders that a border-box height must cover.
    // offsetHeight minus clientHeight is exactly the two border widths. Without
    // this the textarea lands 2px short and stays scrollable by that much,
    // which draws a scrollbar on every turn when scrollbars are set to always
    // show and lets wheel gestures latch onto the turn.
    ta.style.height = `${ta.scrollHeight + ta.offsetHeight - ta.clientHeight}px`;
    if (
      scroller &&
      scrollTopBefore !== undefined &&
      scroller.scrollTop !== scrollTopBefore
    ) {
      scroller.scrollTop = scrollTopBefore;
    }
  }, []);

  useLayoutEffect(() => {
    if (supportsFieldSizing) return;
    resize();
  }, [props.value, resize]);

  useEffect(() => {
    if (supportsFieldSizing) return;
    const ta = ref.current;
    if (!ta) return;
    // Re-measure when the column width changes. Guard on width so setting our
    // own height doesn't feed back into the observer as an endless loop.
    let lastWidth = ta.clientWidth;
    const observer = new ResizeObserver(() => {
      const width = ta.clientWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      resize();
    });
    observer.observe(ta);
    return () => observer.disconnect();
  }, [resize]);

  return (
    <textarea
      ref={ref}
      {...textareaProps}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented) followCaretEdge(event);
      }}
    />
  );
}
