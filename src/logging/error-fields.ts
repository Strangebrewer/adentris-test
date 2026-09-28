/** An error as fields for a structured log line. */
export function errorFields(err: unknown): { error: string; stack?: string } {
  return err instanceof Error ? { error: err.message, stack: err.stack } : { error: String(err) };
}
