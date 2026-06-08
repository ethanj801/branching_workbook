/** Rough token estimate for UI readouts (~4 chars per token). Not exact. */
export function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
