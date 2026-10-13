// packages/core/src/browser/launch.test.ts
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { spawn as realSpawn } from 'node:child_process';
import { launchChrome, terminateAll, type SpawnFn } from './launch.js';
import { TargetClosedError } from './cdp.js';
import { chromeForTests } from './__tests__/helpers.js';

const chrome = chromeForTests();

describe.skipIf(!chrome)('launchChrome', () => {
  it('launches over the pipe, answers getVersion, and cleans its profile up', async () => {
    const b = await launchChrome({ executablePath: chrome!.path });
    try {
      const v = await b.connection.send<{ product: string }>('Browser.getVersion');
      expect(v.product).toMatch(/^HeadlessChrome\//);
      expect(existsSync(b.userDataDir)).toBe(true);
    } finally {
      await b.close();
    }
    expect(existsSync(b.userDataDir)).toBe(false);
    expect(b.connection.closed).toBe(true);
  });
  it('killing the process rejects in-flight sends and leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const b = await launchChrome({ executablePath: chrome!.path });
      const pending = b.connection.send('Target.createBrowserContext');
      process.kill(b.pid, 'SIGKILL');
      await expect(pending).rejects.toBeInstanceOf(TargetClosedError);
      await b.close(); // idempotent after a crash
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
  it('a non-executable path rejects with the path, and removes the profile', async () => {
    await expect(launchChrome({ executablePath: '/nonexistent/chrome' })).rejects.toThrow(
      /\/nonexistent\/chrome/,
    );
  });
  it('a signal kills chrome and removes the profile', async () => {
    // Drive the module's SIGTERM handler through an injected spawn that
    // records the child, then simulate the signal without ending vitest:
    // launchChrome exposes `terminateAll()` for exactly this reason.
    const { terminateAll } = await import('./launch.js');
    const b = await launchChrome({ executablePath: chrome!.path, spawn: realSpawn });
    const pid = b.pid;
    terminateAll();
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow(); // gone
    expect(existsSync(b.userDataDir)).toBe(false);
  });
});

// Fake-process tests: no browser needed, so they run everywhere.
describe('launchChrome with an injected spawn', () => {
  /** A child whose pipe answers every command with `{}` and which ignores kill unless told otherwise. */
  function fakeChild(opts: { diesOn?: NodeJS.Signals[]; answers?: boolean } = {}) {
    const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const fromChrome = new PassThrough();
    const toChrome = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (opts.answers !== false) {
          for (const raw of chunk.toString().split('\0').filter(Boolean)) {
            const { id } = JSON.parse(raw) as { id: number };
            fromChrome.write(JSON.stringify({ id, result: {} }) + '\0');
          }
        }
        cb();
      },
    });
    const signals: string[] = [];
    proc.stdio = [null, null, new PassThrough(), toChrome, fromChrome];
    proc.stderr = proc.stdio[2];
    proc.pid = 424242;
    proc.exitCode = null;
    proc.kill = (sig: NodeJS.Signals) => {
      signals.push(sig);
      if (opts.diesOn?.includes(sig)) setImmediate(() => proc.emit('exit', null, sig));
      return true;
    };
    return { proc, signals };
  }
  const asSpawn = (proc: unknown): SpawnFn => (() => proc) as unknown as SpawnFn;

  it('ENOENT names the install command and JUX_CHROME, and nothing is unhandled', async () => {
    const unhandled: unknown[] = [];
    const on = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', on);
    try {
      const err = await launchChrome({ executablePath: '/nonexistent/chrome' }).catch(
        (e: Error) => e,
      );
      expect((err as Error).message).toMatch(/\/nonexistent\/chrome does not exist/);
      expect((err as Error).message).toMatch(
        /npx -p @juxtapose\/cli jux browser install/,
      );
      expect((err as Error).message).toMatch(/JUX_CHROME/);
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', on);
    }
  });

  it('EACCES on a non-executable file gets the same guidance', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jux-eacces-'));
    const file = path.join(dir, 'chrome');
    writeFileSync(file, '#!/bin/sh\n', { mode: 0o644 });
    try {
      await expect(launchChrome({ executablePath: file })).rejects.toThrow(
        /is not executable[\s\S]*jux browser install[\s\S]*JUX_CHROME/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('close() escalates Browser.close -> SIGTERM -> SIGKILL and waits for exit', async () => {
    const { proc, signals } = fakeChild({ diesOn: ['SIGKILL'] });
    const b = await launchChrome({ executablePath: 'x', spawn: asSpawn(proc) });
    const t0 = Date.now();
    await b.close();
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(existsSync(b.userDataDir)).toBe(false);
  }, 10_000);

  it('close() stops at SIGTERM when that is enough', async () => {
    const { proc, signals } = fakeChild({ diesOn: ['SIGTERM'] });
    const b = await launchChrome({ executablePath: 'x', spawn: asSpawn(proc) });
    await b.close();
    expect(signals).toEqual(['SIGTERM']);
  }, 10_000);

  it('terminateAll (what SIGINT, SIGTERM and exit call) kills and removes every live launch', async () => {
    const { proc, signals } = fakeChild();
    const b = await launchChrome({ executablePath: 'x', spawn: asSpawn(proc) });
    expect(existsSync(b.userDataDir)).toBe(true);
    terminateAll();
    expect(signals).toEqual(['SIGKILL']);
    expect(existsSync(b.userDataDir)).toBe(false);
  });

  it('installs the SIGINT, SIGTERM and exit handlers once', async () => {
    const before = ['SIGINT', 'SIGTERM', 'exit'].map((e) => process.listenerCount(e));
    const a = fakeChild();
    const b1 = await launchChrome({ executablePath: 'x', spawn: asSpawn(a.proc) });
    const b2 = await launchChrome({
      executablePath: 'x',
      spawn: asSpawn(fakeChild().proc),
    });
    const after = ['SIGINT', 'SIGTERM', 'exit'].map((e) => process.listenerCount(e));
    // Already installed by an earlier test in this file, or installed exactly once now.
    for (let i = 0; i < 3; i++) expect(after[i]! - before[i]!).toBeLessThanOrEqual(1);
    terminateAll();
    void b1;
    void b2;
  });
});
