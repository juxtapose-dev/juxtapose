import { useCallback, useMemo, type Dispatch, type SetStateAction } from 'react';
import { useAddonState } from './storybook.js';

/** Storybook 8's addon store falls back on falsy values. Boxing preserves wipe
 * position 0, blend 0, and paused flicker across manager layout remounts. */
export function useReviewState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const fallback = useMemo(() => ({ value: initial }), [initial]);
  const [state, setState] = useAddonState<{ value: T }>(key, fallback);
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      setState((previous) => ({
        value:
          typeof next === 'function'
            ? (next as (previous: T) => T)(previous.value)
            : next,
      }));
    },
    [setState],
  );
  return [state.value, setValue];
}
