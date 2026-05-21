import { useCallback, useEffect, useRef } from "react";

// Debounced callback that always sees the latest function reference, so
// consumers don't need to memoize. Flush via the returned `flush()` helper
// when an outside event (e.g. slide change, page unload) requires the
// pending call to fire immediately.
export function useDebouncedCallback<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delayMs: number,
) {
  const fnRef = useRef(fn);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingArgs = useRef<Args | null>(null);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const debounced = useCallback(
    (...args: Args) => {
      pendingArgs.current = args;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        const a = pendingArgs.current;
        pendingArgs.current = null;
        if (a) fnRef.current(...a);
      }, delayMs);
    },
    [delayMs],
  );

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const a = pendingArgs.current;
    pendingArgs.current = null;
    if (a) fnRef.current(...a);
  }, []);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pendingArgs.current = null;
  }, []);

  return { debounced, flush, cancel };
}
