// A small external store for the work screen (ARCH-01 「웹 화면 구조」, PLAN-26 T-113): each slice is
// a plain mutable object whose fields are read and written as properties (so TypeScript keeps its
// narrowing), plus a version counter that a writer raises with `bump()` after changing it in place.
// React reads a slice through `useStore`; the imperative screen code reads the fields directly.
import { useSyncExternalStore } from 'react';

export interface SliceControls {
  /** Raised by `bump()`; selectors that watch in-place changes read it. */
  readonly version: number;
  /** Tells the subscribers that the slice changed (fields set or objects changed in place). */
  bump(): void;
  subscribe(listener: () => void): () => void;
}
export type Slice<T extends object> = T & SliceControls;

export function createSlice<T extends object>(fields: T): Slice<T> {
  const listeners = new Set<() => void>();
  let version = 0;
  // The controls are not enumerable, so the slice still spreads and serialises as its fields.
  return Object.defineProperties(fields, {
    version: { get: () => version, enumerable: false },
    bump: {
      value: () => {
        version++;
        for (const listener of [...listeners]) listener();
      },
      enumerable: false,
    },
    subscribe: {
      value: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      enumerable: false,
    },
  }) as Slice<T>;
}

/** A component's view of a slice: re-renders when `bump()` changes what the selector returns. */
export function useStore<T extends object, R>(
  slice: Slice<T>,
  selector: (slice: Slice<T>) => R,
): R {
  return useSyncExternalStore(slice.subscribe, () => selector(slice));
}
