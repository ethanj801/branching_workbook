import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

// The chat textareas style themselves with CSS `field-sizing: content` to
// grow with their content, but that property only landed in Chrome 123
// (Mar 2024) and Safari 18 (Sept 2024), and Firefox still doesn't support
// it as of mid-2026. Combined with `resize: none` in the same rule, an
// unsupported browser leaves the user with tiny boxes they can't grow.
//
// This component sets the height inline via scrollHeight on every value
// change, which works in every browser and harmlessly overrides
// field-sizing where the latter does work.
export default function AutoGrowTextarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    // Without field-sizing support, height:auto momentarily collapses the
    // textarea to its CSS min-height during the re-measure's forced reflow.
    // If a long textarea sits inside a scrolled container (the chat
    // transcript), that collapse shrinks the container's content and the
    // browser clamps its scrollTop — permanently, since restoring the
    // height afterwards doesn't restore the scroll. Pin the nearest
    // scrollable ancestor across the two writes.
    let scroller: HTMLElement | null = ta.parentElement;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
      scroller = scroller.parentElement;
    }
    const scrollTopBefore = scroller?.scrollTop;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
    if (
      scroller &&
      scrollTopBefore !== undefined &&
      scroller.scrollTop !== scrollTopBefore
    ) {
      scroller.scrollTop = scrollTopBefore;
    }
  }, [props.value]);

  return <textarea ref={ref} {...props} />;
}
