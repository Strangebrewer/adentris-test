import { setTimeout } from 'node:timers/promises';

/** Polls `check` until it's true, and fails the test if that takes longer than `timeoutMs`. */
export async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await setTimeout(20);
  }
}
