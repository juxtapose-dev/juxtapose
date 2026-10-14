// Unknown keys: a warning, never an error. The runtime has always let them
// through (rejecting them would break configs that run today), but a typo
// like `dely` silently does nothing, so each one is named once, with the
// closest option it could have meant. Derived from the published schema:
// whatever it would flag as an additional property is what is warned about.

import { Kind, type TSchema } from '@sinclair/typebox/type';
import { Errors, ValueErrorType, type ValueError } from '@sinclair/typebox/errors';
import { JuxtaposeParametersSchema, ProjectConfigSchema } from './schema.js';
import { unescapeSeg, walk } from './validate.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keys a file may carry for tools other than jux. */
const EXEMPT = new Set(['$schema']);

/** Additional-property errors, looking into the union branch that fits an
 *  object value best (the one with fewest errors: `storage`'s kinds). */
function* unknownKeyErrors(errors: Iterable<ValueError>): Generator<ValueError> {
  for (const e of errors) {
    if (e.type === ValueErrorType.Union && isRecord(e.value)) {
      const branches = e.errors.map((it) => [...it]);
      const best = branches
        .filter((_, i) => {
          const k = (e.schema.anyOf as TSchema[])[i]?.[Kind];
          return k === 'Object' || k === 'Record';
        })
        .sort((a, b) => a.length - b.length)[0];
      if (best) yield* unknownKeyErrors(best);
    } else if (
      e.type === ValueErrorType.ObjectAdditionalProperties &&
      e.schema[Kind] === 'Object'
    )
      yield e;
  }
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** The known key `key` most likely meant, if any is close: case aside, at
 *  most two edits, or a third of the key for a long one. */
export function closestKey(key: string, known: readonly string[]): string | undefined {
  const lower = key.toLowerCase();
  let best: { k: string; d: number } | undefined;
  for (const k of known) {
    const d = distance(lower, k.toLowerCase());
    if (!best || d < best.d) best = { k, d };
  }
  return best && best.d <= Math.max(2, Math.floor(key.length / 3)) ? best.k : undefined;
}

interface UnknownKey {
  /** Where the object is, e.g. `variants['dark']`, `urls[0].params`; '' at the root. */
  at: string;
  key: string;
  suggestion?: string;
}

function unknownKeys(schema: TSchema, value: unknown): UnknownKey[] {
  if (!isRecord(value)) return [];
  const out: UnknownKey[] = [];
  for (const e of unknownKeyErrors(Errors(schema, value))) {
    const cut = e.path.lastIndexOf('/');
    const key = unescapeSeg(e.path.slice(cut + 1));
    if (EXEMPT.has(key)) continue;
    const { steps } = walk(schema, value, e.path.slice(0, cut));
    const at = steps
      .slice(1)
      .map((s) =>
        s.via === 'prop'
          ? `.${s.key}`
          : s.via === 'entry'
            ? `['${s.key}']`
            : `[${s.key}]`,
      )
      .join('')
      .replace(/^\./, '');
    const suggestion = closestKey(key, Object.keys(e.schema.properties as object));
    out.push({ at, key, ...(suggestion ? { suggestion } : {}) });
  }
  return out;
}

const tail = (u: UnknownKey) =>
  `is ignored${u.suggestion ? ` (did you mean '${u.suggestion}'?)` : ''}`;

/** One warning per unknown key in a project config, in file order. */
export function configWarnings(config: unknown): string[] {
  return unknownKeys(ProjectConfigSchema, config).map(
    (u) =>
      `project config: ${u.at ? `${u.at}: ` : ''}unknown option '${u.key}' ${tail(u)}`,
  );
}

/** One warning per unknown `parameters.juxtapose` key across every capture,
 *  naming the first story that sets it and how many more do. */
export function storyParamWarnings(
  captures: readonly { storyId: string; params: unknown }[],
): string[] {
  const seen = new Map<string, { first: string; more: number; u: UnknownKey }>();
  for (const c of captures)
    for (const u of unknownKeys(JuxtaposeParametersSchema, c.params)) {
      const id = `${u.at}\0${u.key}`;
      const hit = seen.get(id);
      if (hit) hit.more++;
      else seen.set(id, { first: c.storyId, more: 0, u });
    }
  return [...seen.values()].map(
    ({ first, more, u }) =>
      `story '${first}'${more ? ` (and ${more} more)` : ''}: unknown parameters.juxtapose option '${u.at ? `${u.at}.` : ''}${u.key}' ${tail(u)}`,
  );
}
