import { useRef } from "react";

/**
 * Mirrors the latest value into a stable ref. Lets an effect register a global
 * listener once (with the ref in its deps) while the handler still reads fresh
 * values, instead of re-subscribing on every render.
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
