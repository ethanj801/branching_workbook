/** Normalize a thrown value into a user-facing message string. */
export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error";
}
