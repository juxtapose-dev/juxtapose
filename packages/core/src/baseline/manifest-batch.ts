import type { BaselineStore } from '../types.js';

/** The caller supplies a fresh store: no shared instance acquires buffered
 * state, and individual approvals remain immediately durable. */
export async function batchManifest(
  scoped: BaselineStore,
  action: (store: BaselineStore) => Promise<void>,
): Promise<void> {
  let manifest = await scoped.readManifest();
  const persist = scoped.writeManifest.bind(scoped);
  let dirty = false;
  scoped.readManifest = async () => manifest;
  scoped.writeManifest = async (next) => {
    manifest = next;
    dirty = true;
  };
  scoped.batch = undefined;
  await action(scoped);
  if (dirty) await persist(manifest);
}

/** Custom stores without batching retain their existing write semantics. */
export async function batchApprovals(
  store: BaselineStore,
  action: (store: BaselineStore) => Promise<void>,
): Promise<void> {
  if (store.batch) await store.batch(action);
  else await action(store);
}
