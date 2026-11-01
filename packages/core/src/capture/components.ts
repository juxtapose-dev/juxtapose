import { randomUUID } from 'node:crypto';
import type { Page } from '../browser/page.js';
import { loadReactBrowserSource } from '../components/react-browser-source.js';
import type { StructureSnapshot } from '../types.js';
import type { ComponentSnapshot, ComponentTree } from '../components/evidence.js';
import { collectVueComponents } from '../components/vue.js';
import { normalizeRuntimeComponents } from '../components/normalize.js';
import {
  mapRetainedElements,
  installDomMappingGuard,
  finishDomMappingGuard,
  type DomMappingGeometry,
} from '../components/dom-mapping.js';

const initializedPages = new WeakSet<Page>();

/** Install before navigation so React can register its committed roots. */
export async function installComponentCapture(
  page: Page,
  onWarning?: (message: string) => void,
): Promise<void> {
  if (initializedPages.has(page)) return;
  const asset = await loadReactBrowserSource(onWarning);
  if (asset.status !== 'available') return;
  try {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: asset.source });
    initializedPages.add(page);
  } catch {
    // An unavailable diagnostic must not abort the image capture.
  }
}

type Failure = 'masked' | 'dom-changed' | 'budget-exceeded' | 'capture-failed';
export type ComponentCaptureGuard = { key: string } | { reason: Failure };

function unavailable(reason: NonNullable<ComponentTree['reason']>): ComponentSnapshot {
  return {
    schema: 'juxtapose.components/v1',
    trees: (['react', 'vue', 'svelte'] as const).map((framework) => ({
      framework,
      parentRelation: framework === 'svelte' ? 'instrumented-context' : 'rendered-parent',
      elementRelation: framework === 'svelte' ? 'declared-by' : 'rendered-by',
      coverage: framework === 'svelte' ? 'instrumented-only' : 'runtime',
      status: 'unavailable',
      reason,
      truncated: false,
      nodes: [],
    })),
  };
}

/** Run after mask marking; no framework graph is read for masked captures. */
export async function beginComponentCapture(
  page: Page,
  masked: boolean,
): Promise<ComponentCaptureGuard> {
  if (masked) return { reason: 'masked' };
  const key = `jux_components_${randomUUID().replaceAll('-', '')}`;
  try {
    const result = await page.evaluate<unknown>(
      `(${installDomMappingGuard.toString()})(document,${JSON.stringify(key)})`,
    );
    if (
      result &&
      typeof result === 'object' &&
      'status' in result &&
      result.status === 'available'
    )
      return { key };
    return {
      reason:
        result &&
        typeof result === 'object' &&
        'reason' in result &&
        result.reason === 'budget-exceeded'
          ? 'budget-exceeded'
          : 'dom-changed',
    };
  } catch {
    // A rejected response does not prove the browser skipped installing its observer.
    await abandonComponentCapture(page, { key });
    return { reason: 'capture-failed' };
  }
}

export async function abandonComponentCapture(
  page: Page,
  guard: ComponentCaptureGuard,
): Promise<void> {
  if ('key' in guard)
    await page
      .evaluate(
        `(${finishDomMappingGuard.toString()})(document,${JSON.stringify(guard.key)})`,
      )
      .catch(() => {});
}

/** Read all framework ownership in one browser task, then verify its mutation guard. */
export async function finishComponentCapture(
  page: Page,
  snapshot: StructureSnapshot,
  guard: ComponentCaptureGuard,
  geometry: DomMappingGeometry,
): Promise<ComponentSnapshot> {
  if ('reason' in guard) return unavailable(guard.reason);
  const input = JSON.stringify({
    retained: snapshot.elements.map(({ path, tag, rect }) => ({ path, tag, rect })),
    geometry,
    key: guard.key,
  });
  try {
    const result = await page.evaluate<{
      reason?: Failure;
      snapshots?: Parameters<typeof normalizeRuntimeComponents>[0];
      indices?: number[];
    }>(`(() => {
      const input=${input};
      let result;
      try {
        const mapping=(${mapRetainedElements.toString()})(document,input.retained,input.geometry);
        if (mapping.status !== 'available') result={reason:mapping.reason};
        else {
          const elements=mapping.elements;
          const react=globalThis.__juxReactComponents;
          const svelte=globalThis[Symbol.for('juxtapose.svelte.components/v1')];
          const snapshots=[
            react && typeof react.collect === 'function' ? react.collect(elements) : {framework:'react',relation:'rendered-parent',status:'unavailable',reason:'provider_missing',truncated:false,nodes:[]},
            (${collectVueComponents.toString()})(elements),
            svelte && typeof svelte.collect === 'function' ? svelte.collect(elements) : {framework:'svelte',relation:'instrumented-context',elementRelation:'declared-by',status:'unavailable',reason:'not-instrumented',truncated:false,nodes:[]}
          ];
          result={snapshots,indices:mapping.indices};
        }
      } catch { result={reason:'capture-failed'}; }
      finally {
        const guard=(${finishDomMappingGuard.toString()})(document,input.key);
        if (guard.status !== 'available') result={reason:guard.reason};
      }
      return result;
    })()`);
    if (result.reason)
      return unavailable(
        ['masked', 'dom-changed', 'budget-exceeded'].includes(result.reason)
          ? result.reason
          : 'capture-failed',
      );
    if (!Array.isArray(result.snapshots) || !Array.isArray(result.indices))
      return unavailable('capture-failed');
    return (
      normalizeRuntimeComponents(
        result.snapshots,
        result.indices,
        snapshot.elements.length,
      ) ?? unavailable('capture-failed')
    );
  } catch {
    await abandonComponentCapture(page, guard);
    return unavailable('capture-failed');
  }
}
