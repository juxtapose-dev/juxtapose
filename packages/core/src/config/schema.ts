// The one description of juxtapose's configuration (issue #178): the project
// config (juxtapose.config.json) and a story's `parameters.juxtapose`. Three
// things are derived from it and must never be written out by hand again:
//
// - the TypeScript types (`ProjectConfig`, `JuxtaposeParameters`, ...), via
//   Static<>;
// - the published JSON Schema (`@juxtapose/core/schema.json`), which is these
//   objects serialized (scripts/write-schema.mjs);
// - runtime validation (./validate.ts), which runs these schemas and turns the
//   first failure into the message a user has always seen.
//
// Error wording lives next to the shape it describes, under the ErrorText
// symbol. Symbols are not serialized, so it never reaches schema.json or an
// MCP tool schema.
//
// Strict where it is new, lenient where it is old: the published schema
// rejects unknown keys everywhere, so an editor flags a typo, but the runtime
// checks only what it checked before this module existed (see
// ProjectRuntimeSchema and VariantRuntimeSchema). Rejecting at runtime a config
// that runs today is a behavior change of its own and is left for a decision.
//
// Adding an option: add it to the property map it belongs to, with a
// `description` taken from docs/configuration.md and, if the runtime should
// check it, an ErrorText. Types, schema.json, the MCP tool schemas and
// validation follow.

import { Type, type Static, type TOptional, type TSchema } from '@sinclair/typebox';
import type { Viewport } from '../browser/types.js';

// ---------------------------------------------------------------------------
// Bounds

/** A settle cap above this is a typo, not a slow page: it would be paid per story. */
export const MAX_SETTLE_TIMEOUT_MS = 60_000;
/** `storyTimeout` bounds, ms. The top is the largest setTimeout delay (above
 *  it Node fires at once, so every story would fail after 1 ms). */
export const MIN_STORY_TIMEOUT_MS = 1000;
export const MAX_STORY_TIMEOUT_MS = 2 ** 31 - 1;
/** `mcp.concurrency` and `jux mcp --concurrency` upper bound. */
export const MAX_SNAP_SLOTS = 16;
/** Variant names. Underscores are excluded so the `__` key separator can't
 *  occur in a name. */
export const VARIANT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Custom string formats. Registered with TypeBox by ./validate.ts; an editor
 *  that doesn't know them ignores them. */
export const URL_PATTERN_FORMAT = 'jux-url-pattern';
export const CSS_SELECTOR_FORMAT = 'jux-css-selector';

// ---------------------------------------------------------------------------
// Error wording

/** Where validate.ts finds a node's messages. Placeholders: `{got}` the
 *  offending value as JSON, `{value}` it as a string, `{key}` the node's own
 *  property name, `{name}` the nearest map key above it (a story glob, a
 *  variant name), `{extra}` an unexpected key, `{keys}` the expected keys,
 *  `{reason}` why a format check failed. */
export const ErrorText = Symbol.for('juxtapose.config.errorText');

export interface ErrorTexts {
  /** The value has the wrong type or is out of range. Also used for errors
   *  below this node that have no text of their own (an array's items). */
  type?: string;
  /** A string failed its `format` (here or in an array's items). */
  format?: string;
  /** An object has a key it doesn't allow. */
  unknown?: string;
  /** A map has a key that doesn't match its key pattern. */
  badKey?: string;
  /** Put before every message at or below this node. */
  prefix?: string;
  /** Throw SettleConfigError rather than VariantConfigError (both are
   *  declaration errors; the split predates this module). */
  error?: 'settle';
}

type WithText = { [ErrorText]?: ErrorTexts };

/** `schema` carrying `texts`, merged over any it already had. A copy, so a
 *  shared sub-schema can be worded differently where it is used. */
export function withText<T extends TSchema>(schema: T, texts: ErrorTexts): T {
  const own = (schema as WithText)[ErrorText];
  return { ...schema, [ErrorText]: { ...own, ...texts } };
}

// ---------------------------------------------------------------------------
// Shared pieces

const urlPatternList = (description: string) =>
  Type.Array(Type.String({ format: URL_PATTERN_FORMAT }), { description });

/** A URL pattern list under `settle.network`, worded by its key. */
const settlePatterns = (description: string) =>
  withText(urlPatternList(description), {
    type: 'settle.network.{key} must be an array of URL patterns',
    format: 'settle.network.{key}: {reason}',
  });

export const SettleSchema = withText(
  Type.Object(
    {
      timeout: Type.Optional(
        withText(
          Type.Integer({
            minimum: 1,
            maximum: MAX_SETTLE_TIMEOUT_MS,
            description: `The cap on the wait, in ms, from 1 to ${MAX_SETTLE_TIMEOUT_MS}. Default 1500. At the cap the page is captured anyway and the result is flagged settle-timeout.`,
          }),
          {
            type: `settle.timeout must be a whole number of ms from 1 to ${MAX_SETTLE_TIMEOUT_MS}, got {got}`,
          },
        ),
      ),
      ready: Type.Optional(
        withText(
          Type.Boolean({
            description:
              'Also wait until the page calls `window.__juxtapose.ready()`. Default false.',
          }),
          { type: 'settle.ready must be true or false, got {got}' },
        ),
      ),
      network: Type.Optional(
        withText(
          Type.Object(
            {
              ignore: Type.Optional(
                settlePatterns(
                  'URL patterns never counted as pending, added to the built-in list (type:WebSocket, type:EventSource, type:Ping, type:Prefetch). A pattern is a URL glob, a `type:<ResourceType>`, or both.',
                ),
              ),
              require: Type.Optional(
                settlePatterns(
                  'URL patterns that must each see a matching request complete before capture. Wins over `ignore`.',
                ),
              ),
            },
            {
              additionalProperties: false,
              description: 'Which requests the settle wait counts.',
            },
          ),
          {
            type: 'settle.network must be an object',
            unknown: "unknown settle.network option '{extra}' (expected {keys})",
          },
        ),
      ),
    },
    {
      additionalProperties: false,
      description:
        'How long to wait for the page to finish before capture. Layered: project config, then the story, then `stories` overrides, then the command.',
    },
  ),
  {
    type: "'settle' must be an object",
    unknown: "unknown settle option '{extra}' (expected {keys})",
    error: 'settle',
  },
);

export const ExternalNetworkSchema = withText(
  Type.Union([Type.Literal('allow'), Type.Literal('block')], {
    description:
      "`block` fails requests to origins other than the page's own (the story URL's origin) at once. Default `allow`.",
  }),
  { type: "network.external must be 'allow' or 'block', got {got}" },
);

export const NetworkSchema = withText(
  Type.Object(
    { external: Type.Optional(ExternalNetworkSchema) },
    {
      additionalProperties: false,
      description:
        'Which requests the page may make. Layered like `settle`; only values known before navigation apply.',
    },
  ),
  {
    type: "'network' must be an object",
    unknown: "unknown network option '{extra}' (expected {keys})",
    error: 'settle',
  },
);

export const ViewportSchema = Type.Object(
  {
    width: Type.Integer({ minimum: 1, description: 'CSS pixels.' }),
    height: Type.Integer({ minimum: 1, description: 'CSS pixels.' }),
  },
  { additionalProperties: false, description: 'The capture size, in CSS pixels.' },
);

// The browser driver keeps its own Viewport (it must not import the rest of
// core); this fails to compile if the two ever disagree.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _viewportMatches: Same<Static<typeof ViewportSchema>, Viewport> = true;

const cssSelector = (description: string) =>
  Type.String({ minLength: 1, format: CSS_SELECTOR_FORMAT, description });

const NOT_CSS = "'{value}' is not a CSS selector (Playwright-only syntax is refused)";

/** Story capture options, keyed as in `parameters.juxtapose`. Each is worded
 *  for a `stories` entry, the one place the runtime checks them all. */
const captureOptions = {
  skip: withText(Type.Boolean({ description: 'Never capture this story.' }), {
    type: 'skip must be true or false, got {got}',
  }),
  mask: withText(
    Type.Array(
      cssSelector('A CSS selector. Playwright-only syntax (`text=`) is refused.'),
      {
        description:
          "CSS selectors to paint over before the shutter: a solid box over each match's bounding box. For a clock or a random avatar; prefer stubbing the input.",
      },
    ),
    { type: 'mask must be an array of selectors', format: `mask ${NOT_CSS}` },
  ),
  delay: withText(
    Type.Number({
      minimum: 0,
      description:
        'Fixed extra wait after settle, in ms; last resort. Prefer waitForSelector.',
    }),
    { type: 'delay must be a number of ms, 0 or more, got {got}' },
  ),
  waitForSelector: withText(
    cssSelector(
      "Wait for async content juxtapose can't detect: capture once this CSS selector matches.",
    ),
    {
      type: 'waitForSelector must be a CSS selector',
      format: `waitForSelector ${NOT_CSS}`,
    },
  ),
  captureTimeout: withText(
    Type.Number({
      exclusiveMinimum: 0,
      description:
        'Max ms to wait for render-ready before capturing anyway. Default 2000.',
    }),
    { type: 'captureTimeout must be a number of ms above 0, got {got}' },
  ),
  settle: SettleSchema,
  network: NetworkSchema,
  threshold: withText(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description:
        'pixelmatch colour-distance threshold, 0 to 1. Default 0.1. Tunes the reported diff; the hash still decides.',
    }),
    { type: 'threshold must be a number from 0 to 1, got {got}' },
  ),
  minDiffPercent: withText(
    Type.Number({
      minimum: 0,
      maximum: 100,
      description:
        'Mismatch percentage below which a diff still passes, 0 to 100. Default 0. Tunes the reported diff; the hash still decides.',
    }),
    { type: 'minDiffPercent must be a percentage from 0 to 100, got {got}' },
  ),
};

/** Options only a story (or a variant) sets; not available to `stories`. */
const storyOnlyOptions = {
  viewport: ViewportSchema,
  animations: Type.Union([Type.Literal('play'), Type.Literal('disabled')], {
    description:
      "CSS animations during capture. Default 'disabled' so spinners don't flake; 'play' lets them run (for stories testing animation).",
  }),
  captureAfterPlay: Type.Boolean({
    description: "Screenshot after the story's play function, not at first render.",
  }),
};

const optional = <P extends Record<string, TSchema>>(props: P) =>
  Object.fromEntries(Object.entries(props).map(([k, v]) => [k, Type.Optional(v)])) as {
    [K in keyof P]: TOptional<P[K]>;
  };

// ---------------------------------------------------------------------------
// Variants

const variantName = (description: string) =>
  Type.String({ pattern: VARIANT_NAME.source, description });

const COLOR_SCHEME = withText(
  Type.Union([Type.Literal('light'), Type.Literal('dark')], {
    description:
      'prefers-color-scheme for this variant. The default capture is always light.',
  }),
  { type: "variant '{name}' colorScheme must be 'light' or 'dark'" },
);
const EXTENDS = withText(
  Type.String({
    description:
      'Another variant (of this story or the project) whose fields this one starts from. Chains resolve; a cycle or an unknown name is an error.',
  }),
  { type: "variant '{name}' extends must be a variant name" },
);
const VARIANT_SETTLE = withText(SettleSchema, { prefix: "variant '{name}': " });
const VARIANT_NETWORK = withText(NetworkSchema, { prefix: "variant '{name}': " });

const { skip: _skip, ...variantCaptureOptions } = captureOptions;

/** One named variant: any story option but `skip`, `variants` and
 *  `liveCapture`, plus a color scheme and a variant to extend. */
export const VariantSchema = Type.Object(
  {
    ...optional(storyOnlyOptions),
    ...optional(variantCaptureOptions),
    settle: Type.Optional(VARIANT_SETTLE),
    network: Type.Optional(VARIANT_NETWORK),
    colorScheme: Type.Optional(COLOR_SCHEME),
    extends: Type.Optional(EXTENDS),
  },
  {
    additionalProperties: false,
    description:
      'A named capture variant, captured, judged and approved on its own under `<story id>__<name>`. `skip` is not an option; set the variant to false instead.',
  },
);

const variantsMap = <T extends TSchema>(value: T, description: string) =>
  withText(
    Type.Record(
      variantName('lowercase letters, digits and dashes; no underscores'),
      withText(Type.Union([Type.Literal(false), value]), {
        type: "variant '{name}' must be an object of capture settings, or false to opt out",
      }),
      { additionalProperties: false, description },
    ),
    {
      type: "'variants' must be an object of named variants",
      badKey: `variant name '{extra}' must match ${VARIANT_NAME.source} (lowercase letters, digits and dashes; no underscores)`,
    },
  );

const VARIANTS_DESCRIPTION =
  'Named capture variants, each captured, judged and approved on its own under `<story id>__<name>`. `false` opts out of a project-wide variant of that name.';

export const VariantsSchema = variantsMap(VariantSchema, VARIANTS_DESCRIPTION);

/** What the runtime checks in a variant: what it checked before #178. The
 *  rest of VariantSchema is the editor's (see the header). */
export const VariantRuntimeSchema = Type.Object({
  skip: Type.Optional(
    withText(Type.Never(), {
      type: "variant '{name}' sets 'skip'; set the variant to false instead",
    }),
  ),
  colorScheme: Type.Optional(COLOR_SCHEME),
  settle: Type.Optional(VARIANT_SETTLE),
  network: Type.Optional(VARIANT_NETWORK),
  extends: Type.Optional(EXTENDS),
});
export const VariantsRuntimeSchema = variantsMap(
  VariantRuntimeSchema,
  VARIANTS_DESCRIPTION,
);

// ---------------------------------------------------------------------------
// Story parameters

/** Everything `parameters.juxtapose` (Storybook) or `meta.juxtapose` (Ladle)
 *  accepts. */
export const JuxtaposeParametersSchema = Type.Object(
  {
    ...optional(captureOptions),
    ...optional(storyOnlyOptions),
    liveCapture: Type.Optional(
      Type.Boolean({
        description:
          'false excludes this story from watch-mode recapture while leaving normal runs alone. Default true.',
      }),
    ),
    variants: Type.Optional(VariantsSchema),
    colorScheme: Type.Optional(
      Type.Union([Type.Literal('light'), Type.Literal('dark')], {
        description:
          "Set on a variant's resolved params. The default capture is always light, so a story's own colorScheme is ignored.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      'Per-story capture options: `parameters.juxtapose` in Storybook, `meta.juxtapose` in Ladle.',
  },
);

// ---------------------------------------------------------------------------
// Per-story overrides in the project config

/** A `stories` entry: the story options that are about stability, plus the
 *  two diff tolerances. Checked in full at runtime. */
export const StoryOverrideSchema = withText(
  Type.Object(optional(captureOptions), {
    additionalProperties: false,
    description:
      "Options for the stories this glob matches, with the meaning they have in `parameters.juxtapose`. Layered over the story's own.",
  }),
  {
    type: 'must be an object of capture settings',
    unknown: "unknown option '{extra}' (expected {keys})",
    prefix: "stories['{name}']: ",
  },
);

export const StoriesSchema = withText(
  Type.Record(Type.String({ pattern: '\\S' }), StoryOverrideSchema, {
    additionalProperties: false,
    description:
      "Per-story overrides keyed by story id glob, for a workbench you don't own. `*` matches anything but `/`, `**` anything, `?` one character. A key matching a story id covers its variants; `<id>__<variant>` targets one variant.",
  }),
  {
    type: "'stories' must be an object of story id globs",
    badKey: "stories['{extra}']: the story id glob must not be empty",
  },
);

// ---------------------------------------------------------------------------
// Project config

const settleScalar = <T extends TSchema>(schema: T, type: string) =>
  withText(schema, { type, error: 'settle' });

/** The project options the runtime checks, in the order it checks them. */
const projectChecked = {
  freshRenderer: settleScalar(
    Type.Boolean({
      description:
        "Start each cold capture after a page's first in a new renderer process, so a story's hash doesn't depend on the story captured before it. Default true; false trades that for speed (about 220 ms per Storybook story).",
    }),
    'freshRenderer must be true or false, got {got}',
  ),
  storyTimeout: settleScalar(
    Type.Integer({
      minimum: MIN_STORY_TIMEOUT_MS,
      maximum: MAX_STORY_TIMEOUT_MS,
      description:
        'Budget for capturing one story, navigation through encode, in ms (whole number from 1000). Default 60000. A story that uses it all fails once with an error naming the step it was stuck in.',
    }),
    `storyTimeout must be a whole number of ms, ${MIN_STORY_TIMEOUT_MS} to ${MAX_STORY_TIMEOUT_MS}, got {got}`,
  ),
  settle: SettleSchema,
  network: NetworkSchema,
  stories: StoriesSchema,
  waitForSelector: settleScalar(
    Type.String({ description: "Project-wide `waitForSelector`; a story's own wins." }),
    'waitForSelector must be a CSS selector',
  ),
  delay: settleScalar(
    Type.Number({
      minimum: 0,
      description: "Project-wide `delay`, ms; a story's own wins.",
    }),
    'delay must be a number of ms, 0 or more',
  ),
};

export const StorageConfigSchema = Type.Union(
  [
    Type.Object(
      {
        kind: Type.Literal('git'),
        dir: Type.Optional(Type.String({ description: 'Baseline image directory.' })),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('fs'),
        dir: Type.String({ description: 'Baseline image directory.' }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('s3'),
        bucket: Type.String(),
        prefix: Type.Optional(Type.String()),
        endpoint: Type.Optional(Type.String()),
      },
      {
        additionalProperties: false,
        description: 'Not implemented yet; the CLI refuses it.',
      },
    ),
  ],
  {
    description:
      'Where baseline images live. The manifest is always in git. Default `{ "kind": "git" }`.',
  },
);

export const UrlEntrySchema = Type.Object(
  {
    id: Type.String({
      description: 'Stable id; used as the story id and for file names.',
    }),
    url: Type.String({ description: 'Absolute, or relative to `origin`.' }),
    params: Type.Optional(JuxtaposeParametersSchema),
    variants: Type.Optional(VariantsSchema),
  },
  { additionalProperties: false, description: 'One page for the `urls` platform.' },
);

export const ProjectConfigSchema = Type.Object(
  {
    $schema: Type.Optional(
      Type.String({ description: 'The JSON Schema this file follows, for editors.' }),
    ),
    platform: Type.Optional(
      Type.Union(
        [Type.Literal('storybook'), Type.Literal('ladle'), Type.Literal('urls')],
        {
          description: 'Which workbench. Autodetected when omitted.',
        },
      ),
    ),
    urls: Type.Optional(
      Type.Array(UrlEntrySchema, {
        description: "Pages to capture when `platform` is 'urls'.",
      }),
    ),
    buildDir: Type.Optional(
      Type.String({
        description:
          'The built static workbench, relative to the project root. jux serves it for the length of the run. The `--build-dir` flag overrides it.',
      }),
    ),
    origin: Type.Optional(
      Type.String({
        description:
          'Capture a running or deployed workbench at this URL instead of a build. The `--origin` flag overrides it.',
      }),
    ),
    concurrency: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          'Parallel pages. Default 8. Past your core count, contention slows captures down.',
      }),
    ),
    warmSwitch: Type.Optional(
      Type.Boolean({
        description:
          "Switch stories in place instead of navigating. ~4x faster, but doesn't reproduce cold-load pixels exactly, so a story's verdict can depend on queue order. Default false.",
      }),
    ),
    ...optional(projectChecked),
    viewport: Type.Optional(ViewportSchema),
    threshold: Type.Optional(captureOptions.threshold),
    minDiffPercent: Type.Optional(captureOptions.minDiffPercent),
    variants: Type.Optional(VariantsSchema),
    storage: Type.Optional(StorageConfigSchema),
    mcp: Type.Optional(
      Type.Object(
        {
          concurrency: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: MAX_SNAP_SLOTS,
              description: `Snaps \`jux mcp\` captures at once, 1 to ${MAX_SNAP_SLOTS}. Default half the CPU cores, 1 to 4.`,
            }),
          ),
        },
        { additionalProperties: false, description: '`jux mcp` settings.' },
      ),
    ),
  },
  {
    additionalProperties: false,
    title: 'juxtapose config',
    description:
      'juxtapose.config.json, .juxtaposerc.json, or the `juxtapose` key in package.json.',
  },
);

/** What the runtime checks in a project config before any browser starts:
 *  the same property schemas, in the order the checks have always run, with
 *  unknown keys let through (see the header). `variants` is checked when
 *  stories are expanded. */
export const ProjectRuntimeSchema = Type.Object(optional(projectChecked));

// ---------------------------------------------------------------------------
// Types

export type SettleParams = Static<typeof SettleSchema>;
export type NetworkParams = Static<typeof NetworkSchema>;
export type ExternalNetwork = Static<typeof ExternalNetworkSchema>;
export type VariantSpec = Static<typeof VariantSchema>;
export type JuxtaposeParameters = Static<typeof JuxtaposeParametersSchema>;
export type StoryOverride = Static<typeof StoryOverrideSchema>;
export type StorageConfig = Static<typeof StorageConfigSchema>;
export type UrlEntry = Static<typeof UrlEntrySchema>;
export type ProjectConfig = Static<typeof ProjectConfigSchema>;
