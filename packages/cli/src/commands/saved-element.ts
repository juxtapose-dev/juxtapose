import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  decodeStructure,
  encodeStoryId,
  inspectStructureElement,
  type ElementInspection,
  type ElementQuery,
  type StructureSnapshot,
} from '@juxtapose/core';
import { savedRunReportPath } from './agent-run-report.js';

/** Reuse decoded snapshots while checking for in-place changes independently
 * of report.json: style inspection should neither recapture nor return stale data. */
export class SavedElementCache {
  private readonly entries = new Map<
    string,
    { signature: string; snapshot: Promise<StructureSnapshot> }
  >();
  async lookup(
    project: string,
    runId: string,
    story: string,
    query: ElementQuery,
    properties?: string[],
  ): Promise<
    | ElementInspection
    | { schema: 'juxtapose.current-element/v1'; status: 'unavailable'; reason: string }
  > {
    const reportFile = await savedRunReportPath(project, runId);
    let file: string;
    try {
      const runDir = path.dirname(reportFile),
        imageDir = await realpath(path.join(runDir, 'images'));
      if (!imageDir.startsWith(runDir + path.sep))
        throw new Error('saved structure directory escapes the run');
      file = await realpath(
        path.join(imageDir, `${encodeStoryId(story)}-current.structure.json.gz`),
      );
      if (!file.startsWith(imageDir + path.sep))
        throw new Error('saved structure escapes the run');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return {
          schema: 'juxtapose.current-element/v1',
          status: 'unavailable',
          reason: 'missing-current-structure',
        };
      throw error;
    }
    const info = await stat(file),
      signature = `${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    let entry = this.entries.get(file);
    if (entry?.signature !== signature) {
      entry = { signature, snapshot: readFile(file).then(decodeStructure) };
      const pending = entry;
      void pending.snapshot.catch(() => {
        if (this.entries.get(file) === pending) this.entries.delete(file);
      });
    }
    this.entries.delete(file);
    this.entries.set(file, entry);
    if (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value!);
    return inspectStructureElement(await entry.snapshot, query, properties);
  }
}
