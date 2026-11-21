/**
 * Wait for an in-flight promise during shutdown, but never longer than
 * `timeoutMs`. Returns true when the work finished, false when it timed out.
 * The timeout is cleared as soon as the work settles so it cannot keep the
 * event loop alive after a clean drain.
 */
export async function waitForInFlightWork(
  work: Promise<unknown> | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (work === undefined) return true;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (drained: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(drained);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    work.then(
      () => finish(true),
      () => finish(true),
    );
  });
}
