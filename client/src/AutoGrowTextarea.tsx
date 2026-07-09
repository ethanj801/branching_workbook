import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
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
  const ref = useRef<HTMLTextAreaElement | null>(null);

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

  return <textarea ref={ref} {...props} />;
}
