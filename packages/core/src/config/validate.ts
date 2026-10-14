// Runtime validation from config/schema.ts: TypeBox checks the value, and the
// first error becomes the message users have always seen. The wording comes
// from the ErrorText on the schema node that failed (or the nearest one above
// it), with the `prefix` texts of the nodes on the way down in front. The
// messages are pinned byte for byte by validate.test.ts.

import { FormatRegistry, Kind, type TSchema } from '@sinclair/typebox';
import { Value, ValueErrorType, type ValueError } from '@sinclair/typebox/value';
import { isCssSelector } from '../browser/selectors.js';
import { SettleConfigError, VariantConfigError } from '../capture/config-errors.js';
import { parsePattern } from '../capture/url-pattern.js';
import {
  CSS_SELECTOR_FORMAT,
  ErrorText,
  URL_PATTERN_FORMAT,
  type ErrorTexts,
} from './schema.js';

/** Why a value failed a format, for `{reason}`. */
const formatReasons: Record<string, (v: string) => string | undefined> = {
  [URL_PATTERN_FORMAT]: (v) => {
    try {
      parsePattern(v);
      return undefined;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  },
  [CSS_SELECTOR_FORMAT]: (v) => (isCssSelector(v) ? undefined : 'not a CSS selector'),
};
for (const [name, reason] of Object.entries(formatReasons))
  if (!FormatRegistry.Has(name)) FormatRegistry.Set(name, (v) => reason(v) === undefined);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const textsOf = (s: TSchema): ErrorTexts | undefined =>
  (s as { [ErrorText]?: ErrorTexts })[ErrorText];

const isMap = (s: TSchema) => s[Kind] === 'Object' || s[Kind] === 'Record';

/** For a value that is an object, the union branch that describes objects:
 *  `false | {...}` (a variant) reports what is wrong inside the object. */
const objectBranch = (s: TSchema): TSchema | undefined =>
  s[Kind] === 'Union' ? (s.anyOf as TSchema[]).find(isMap) : undefined;

/** Every error, looking through a union to its object branch when the value
 *  is an object, so a bad variant reports what is wrong inside it. */
function* flatten(errors: Iterable<ValueError>): Generator<ValueError> {
  for (const e of errors) {
    const i =
      e.type === ValueErrorType.Union && isRecord(e.value)
        ? (e.schema.anyOf as TSchema[]).findIndex(isMap)
        : -1;
    const inner = i >= 0 ? e.errors[i] : undefined;
    if (inner) yield* flatten(inner);
    else yield e;
  }
}

/**
 * The error the hand-written checks would have hit first. TypeBox's order
 * already matches them within an object (unknown keys first, then each
 * option in schema order). Two places differ, and the order key fixes both:
 * a map's entries are checked in the order they are written, a bad key with
 * its entry rather than after every good one; and an array's items are all
 * type-checked before any is format-checked, so `[1, 'text=x']` is "not an
 * array of selectors" rather than "not a CSS selector".
 */
function firstError(schema: TSchema, value: unknown): ValueError | undefined {
  if (Value.Check(schema, value)) return undefined;
  const all = [...flatten(Value.Errors(schema, value))];
  const keyed = all.map((e, i) => ({ e, i, k: walk(schema, value, e.path, e).order }));
  keyed.sort((a, b) => compareOrder(a.k, b.k) || a.i - b.i);
  return keyed[0]?.e;
}

/** Element-wise; a key that is a prefix of the other ties. */
function compareOrder(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

interface Step {
  schema: TSchema;
  value: unknown;
  /** The property name or index that led here. */
  key?: string;
  /** The nearest map key at or above this step. */
  name?: string;
}

const unescapeSeg = (s: string) => s.replace(/~1/g, '/').replace(/~0/g, '~');

/** The schema nodes from the root down to `pointer`, as far as they go, and
 *  the order key of an error there (see firstError). */
function walk(
  root: TSchema,
  value: unknown,
  pointer: string,
  error?: ValueError,
): { steps: Step[]; order: number[] } {
  const steps: Step[] = [{ schema: root, value }];
  const order: number[] = [];
  let cur = root;
  let v = value;
  let name: string | undefined;
  for (const seg of pointer.split('/').slice(1).map(unescapeSeg)) {
    if (isRecord(v)) cur = objectBranch(cur) ?? cur;
    let next: TSchema | undefined;
    if (cur[Kind] === 'Object') next = (cur.properties as Record<string, TSchema>)[seg];
    else if (cur[Kind] === 'Record') {
      next = Object.values(cur.patternProperties as Record<string, TSchema>)[0];
      name = seg;
      order.push(isRecord(v) ? Object.keys(v).indexOf(seg) : 0);
    } else if (cur[Kind] === 'Array') {
      next = cur.items as TSchema;
      order.push(error?.type === ValueErrorType.StringFormat ? 1 : 0);
    }
    if (!next) break;
    v = (v as Record<string, unknown> | undefined)?.[seg];
    cur = next;
    steps.push({ schema: next, value: v, key: seg, name });
  }
  return { steps, order };
}

const fill = (template: string, vars: Record<string, string | undefined>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);

/** A message for `e`, without the `where` prefix, and the error class. */
function describe(root: TSchema, value: unknown, e: ValueError) {
  const unknownKey = e.type === ValueErrorType.ObjectAdditionalProperties;
  const pointer = unknownKey ? e.path.slice(0, e.path.lastIndexOf('/')) : e.path;
  const { steps } = walk(root, value, pointer);
  const extra = unknownKey
    ? unescapeSeg(e.path.slice(e.path.lastIndexOf('/') + 1))
    : undefined;
  const field: keyof ErrorTexts = unknownKey
    ? e.schema[Kind] === 'Record'
      ? 'badKey'
      : 'unknown'
    : e.type === ValueErrorType.StringFormat
      ? 'format'
      : 'type';
  let owner = steps.length - 1;
  while (owner > 0 && textsOf(steps[owner]!.schema)?.[field] === undefined) owner--;
  const step = steps[owner]!;
  const template = textsOf(step.schema)?.[field];
  const vars = (s: Step) => ({
    got: String(JSON.stringify(s.value)),
    value: String(e.value),
    key: s.key,
    name: s.name,
    extra,
    keys: Object.keys((s.schema.properties as object | undefined) ?? {}).join(', '),
    reason:
      typeof e.schema.format === 'string' && typeof e.value === 'string'
        ? formatReasons[e.schema.format]?.(e.value)
        : undefined,
  });
  const prefix = steps
    .slice(0, owner + 1)
    .map((s) =>
      textsOf(s.schema)?.prefix ? fill(textsOf(s.schema)!.prefix!, vars(s)) : '',
    )
    .join('');
  const message =
    template !== undefined
      ? fill(template, vars(step))
      : // Only reachable through a schema the runtime doesn't use (an editor-only
        // part of the published schema): say where and what TypeBox said.
        `${e.path.slice(1).replace(/\//g, '.') || 'value'}: ${e.message}`;
  const settle = steps
    .slice(0, owner + 1)
    .some((s) => textsOf(s.schema)?.error === 'settle');
  return { message: prefix + message, settle };
}

/** The first problem with `value` under `schema`, worded for users, or
 *  undefined when it is valid. */
export function configError(
  schema: TSchema,
  value: unknown,
): { message: string; settle: boolean } | undefined {
  const e = firstError(schema, value);
  return e ? describe(schema, value, e) : undefined;
}

/**
 * Check `value` against `schema` where it is declared; `where` names the
 * place to edit (`project config`, `story 'button--primary'`). Throws
 * SettleConfigError for settle, network and project capture scalars,
 * VariantConfigError for the rest, as the hand-written checks did.
 */
export function validate<T>(schema: TSchema, value: unknown, where: string): T {
  const err = configError(schema, value);
  if (!err) return value as T;
  const Err = err.settle ? SettleConfigError : VariantConfigError;
  throw new Err(`${where}: ${err.message}`);
}
