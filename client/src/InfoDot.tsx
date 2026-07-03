import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type InfoDotProps = {
  /** Tooltip body, also used as the accessible label. */
  info: string;
  /** Character shown inside the dot. */
  glyph?: string;
};

/**
 * A small info dot with a viewport-positioned tooltip, following the node map
 * tooltip pattern. The bubble portals into document.body at position fixed, so
 * no scrolling or transformed ancestor can clip it. It shows on hover and on
 * keyboard focus, and hides on leave, blur, or Escape. The dot lives inside
 * label elements where a click would activate the label's control, so clicks
 * are swallowed.
 */
export default function InfoDot({ info, glyph = "i" }: InfoDotProps) {
  const dotRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(
    null,
  );

  // Place the bubble once it has rendered and can be measured. Centered above
  // the dot, clamped inside the viewport, flipped below when there is no room.
  // The bubble is position fixed, so any scroll or resize while it is open
  // moves the dot out from under it. Re-measuring on those events keeps the
  // bubble attached.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    function place() {
      const dot = dotRef.current;
      const tip = tipRef.current;
      if (!dot || !tip) return;
      const dotRect = dot.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      const margin = 8;
      const left = Math.max(
        margin,
        Math.min(
          dotRect.left + dotRect.width / 2 - tipRect.width / 2,
          window.innerWidth - tipRect.width - margin,
        ),
      );
      const above = dotRect.top - tipRect.height - 6;
      const top = above >= margin ? above : dotRect.bottom + 6;
      setPosition({ left, top });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // Escape while a tooltip is open dismisses only the tooltip. Stop the
      // event here so App's window handler does not also close the drawer or
      // popover the dot lives in.
      event.stopPropagation();
      setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <span
      ref={dotRef}
      className="bw-info-dot"
      tabIndex={0}
      aria-label={info}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={(event) => {
        // Mouse clicks focus the dot too. Only keyboard focus should show the
        // tooltip, or a click would pin it open after the pointer leaves.
        if (event.currentTarget.matches(":focus-visible")) setOpen(true);
      }}
      onBlur={() => setOpen(false)}
      onClick={(event) => event.preventDefault()}
    >
      {glyph}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            className="bw-info-tooltip"
            role="tooltip"
            style={position ?? { visibility: "hidden", left: 0, top: 0 }}
          >
            {info}
          </div>,
          document.body,
        )}
    </span>
  );
}
