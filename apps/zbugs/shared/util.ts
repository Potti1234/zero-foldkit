// Small helpers ported from @rocicorp/mono's internal shared package so the
// zbugs sources port without dependency on mono internals.

export function must<T>(value: T | null | undefined, msg?: string): T {
  if (value === null || value === undefined) {
    throw new Error(msg ?? 'Expected value to be defined');
  }
  return value;
}

export function assert(
  condition: unknown,
  msg?: string,
): asserts condition {
  if (!condition) {
    throw new Error(msg ?? 'Assertion failed');
  }
}

export function groupBy<T, K>(
  iterable: Iterable<T>,
  key: (item: T) => K,
): Map<K, Array<T>> {
  const map = new Map<K, Array<T>>();
  for (const item of iterable) {
    const k = key(item);
    const group = map.get(k);
    if (group) {
      group.push(item);
    } else {
      map.set(k, [item]);
    }
  }
  return map;
}
