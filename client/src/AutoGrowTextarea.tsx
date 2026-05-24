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
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [props.value]);

  return <textarea ref={ref} {...props} />;
}
