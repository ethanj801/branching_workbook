/**
 * Fast non-cryptographic 64-bit hash (cyrb64) used as a stand-in for the
 * xxhash3-64 called out in spec §3.3. Used for `priorContextHash` — stamping
 * each node with a hash of the root→parent text at creation time so
 * stale-ancestor detection works after an ancestor is edited. We don't need
 * cryptographic properties; we need stable, well-distributed 64-bit output
 * that computes fast in pure JS with zero deps.
 */
export function contextHash(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0")
  );
}
