// Browser regression checks against the actual manager bundle; API responses
// are controlled so failures, missing artifacts and delayed runs are repeatable.
import assert from 'node:assert/strict';

export async function checkStorybookPanel(page, storyId) {
  page.on('Fetch.requestPaused', (event) => {
    void page.send('Fetch.fulfillRequest', {
      requestId: event.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'image/svg+xml' }],
      body: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="white"/></svg>',
      ).toString('base64'),
    });
  });
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*/jux/api/image/*' }] });
  await page.evaluate((id) => {
    const result = {
      storyId: id,
      status: 'fail',
      hash: 'abc',
      mismatchPixels: 10,
      mismatchPercent: 0.1,
      changedRegions: [],
      durationMs: 1,
    };
    globalThis.__juxFixture = {
      report: {
        runId: 'panel-1',
        results: [result],
        summary: { pass: 0, fail: 1, new: 0, stale: 0, skip: 0 },
      },
      approved: [],
      running: false,
    };
    globalThis.__juxActions = [];
    globalThis.__juxRunReject = false;
    globalThis.__juxStaleNext = false;
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/bundle')) {
        const body = JSON.stringify(globalThis.__juxFixture);
        if (globalThis.__juxStaleNext) {
          globalThis.__juxStaleNext = false;
          globalThis.__juxStalePending = true;
          await new Promise((resolve) => setTimeout(resolve, 3500));
          globalThis.__juxStalePending = false;
        }
        if (globalThis.__juxBundleDelay)
          await new Promise((resolve) =>
            setTimeout(resolve, globalThis.__juxBundleDelay),
          );
        return new Response(body);
      }
      if (url.endsWith('/progress'))
        return Response.json({
          ...globalThis.__juxFixture,
          done: 0,
          total: 1,
          storyId: id,
        });
      if (url.includes('/handoff/'))
        return new Response('Review this controlled visual change.');
      if (init?.method === 'POST' && /\/(run|approve|cancel)$/.test(url)) {
        globalThis.__juxActions.push(url.split('/').pop());
        if (url.endsWith('/run')) {
          if (globalThis.__juxRunReject)
            return Response.json({ error: 'Controlled run rejection' }, { status: 400 });
          globalThis.__juxFixture.running = true;
          globalThis.__juxFixture.run = { id: 'attempt', status: 'running' };
        }
        if (url.endsWith('/cancel')) {
          globalThis.__juxFixture.running = false;
          globalThis.__juxFixture.run = { id: 'attempt', status: 'cancelled' };
        }
        if (url.endsWith('/approve')) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          globalThis.__juxFixture.approved = [id];
        }
        return Response.json({});
      }
      return original(input, init);
    };
  }, storyId);
  await textAppears(page, 'What changed');
  console.log('panel: comparison controls');
  await click(page, 'Slider');
  await page.waitForFunction(
    () => globalThis.document.querySelector('[role="slider"]') !== null,
  );
  await page.evaluate(() =>
    globalThis.document
      .querySelector('[role="slider"]')
      .dispatchEvent(
        new globalThis.KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      ),
  );
  await page.waitForFunction(
    () =>
      globalThis.document
        .querySelector('[role="slider"]')
        ?.getAttribute('aria-valuenow') === '100',
  );
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await click(page, 'Flicker');
  await textAppears(page, 'Play flicker');
  await click(page, 'Play flicker');
  await textAppears(page, 'Pause flicker');
  await click(page, 'Pause flicker');

  await change(page, {
    result: {
      baselineImage: 'unavailable',
      structural: {
        summary: 'Button text changed from Save to Submit.',
        classification: 'text-only',
        deltas: [{ kind: 'text', el: 'button', from: 'Save', to: 'Submit' }],
        deltaCount: 3,
        explained: 'partial',
        unexplainedRegions: [{}],
        flags: ['structure-truncated'],
      },
    },
  });
  await textAppears(page, 'Button text changed from Save to Submit.');
  await page.evaluate(() =>
    [...globalThis.document.querySelectorAll('summary')]
      .find((x) => x.textContent.includes('Change evidence'))
      .click(),
  );
  await textAppears(page, 'Showing 1 of 3 changes');
  assert.equal(
    await buttonExists(page, 'Slider'),
    false,
    'missing baseline must not offer comparison',
  );
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    }),
  );
  await click(page, 'Copy agent prompt');
  await textAppears(page, 'Could not copy prompt');
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.querySelector('textarea[aria-label="Agent prompt"]')?.value,
    ),
    'Review this controlled visual change.',
  );

  await change(page, {
    result: { error: 'Controlled capture error', mismatchPixels: 0, mismatchPercent: 0 },
  });
  await textAppears(page, 'Controlled capture error');
  assert.equal(await buttonExists(page, 'Approve (a)'), false);
  assert.equal(
    await page.evaluate(() =>
      globalThis.document.body.textContent.includes('Too subtle for the diff overlay'),
    ),
    false,
  );

  await page.evaluate(() => {
    globalThis.__juxRunReject = true;
  });
  await click(page, 'Capture story');
  await textAppears(page, 'Controlled run rejection');
  // A successful poll must not erase an action failure.
  await change(page, { runId: 'after-error' });
  await page.waitForFunction(() =>
    [...globalThis.document.querySelectorAll('img')].every(
      (x) => !x.src.includes('panel-images'),
    ),
  );
  await page.evaluate(() => {
    globalThis.__juxRunReject = false;
  });
  await click(page, 'Capture story');
  await page.waitForFunction(() =>
    [...globalThis.document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === 'Capture story')
      ?.matches(':disabled, [aria-disabled="true"]'),
  );
  console.log('panel: cancelling run');
  await click(page, 'Cancel');
  await textAppears(page, 'Latest run cancelled');

  await change(page, {
    result: { error: null, baselineImage: null, unstable: { hashes: ['a', 'b'] } },
  });
  await textAppears(page, 'Unstable:');
  assert.equal(await buttonExists(page, 'Approve (a)'), false);
  await change(page, { result: { unstable: null, status: 'new', structural: null } });
  await page.waitForFunction(() =>
    [...globalThis.document.querySelectorAll('button')].some(
      (b) =>
        b.textContent.trim() === 'Approve (a)' &&
        !b.matches(':disabled, [aria-disabled="true"]'),
    ),
  );
  await page.evaluate(() => {
    globalThis.document.body.dispatchEvent(
      new globalThis.KeyboardEvent('keydown', { key: 'a', bubbles: true }),
    );
    globalThis.document.body.dispatchEvent(
      new globalThis.KeyboardEvent('keydown', { key: 'a', repeat: true, bubbles: true }),
    );
    globalThis.document.body.dispatchEvent(
      new globalThis.KeyboardEvent('keydown', { key: 'a', bubbles: true }),
    );
  });
  await textAppears(page, 'Approved');
  assert.equal(
    await page.evaluate(
      () => globalThis.__juxActions.filter((x) => x === 'approve').length,
    ),
    1,
  );
  console.log('panel: stale polling');
  await page.evaluate(() => {
    globalThis.__juxStaleNext = true;
  });
  await page.waitForFunction(() => globalThis.__juxStalePending === true);
  await change(page, { result: { error: 'Newer capture error' } });
  await textAppears(page, 'Newer capture error');
  await page.waitForFunction(() => globalThis.__juxStalePending === false);
  assert.equal(
    await page.evaluate(() =>
      globalThis.document.body.textContent.includes('Newer capture error'),
    ),
    true,
    'late poll must not replace newer evidence',
  );
  await page.evaluate(() => {
    globalThis.__juxFixture.run = {
      id: 'failed-background',
      status: 'failed',
      error: 'Controlled background failure',
    };
  });
  await textAppears(page, 'Latest run failed: Controlled background failure');
  // A response slower than the 2s polling interval must still be applied.
  // Previously every next request invalidated the preceding response forever.
  await page.evaluate(() => {
    globalThis.__juxBundleDelay = 2400;
    globalThis.__juxFixture.report.results[0].error = 'Slow server result delivered';
  });
  await textAppears(page, 'Slow server result delivered');
  await page.evaluate(() => {
    globalThis.__juxBundleDelay = 0;
  });
  await page.evaluate(() => {
    globalThis.__juxFixture.report = null;
    globalThis.__juxFixture.run = undefined;
  });
  await textAppears(page, 'No run yet');
  await click(page, 'Capture this story');
  await textAppears(page, 'Capturing stories…');
  console.log('panel: cancelling run');
  await click(page, 'Cancel');
  await textAppears(page, 'Latest run cancelled');
  console.log(
    'PASS panel explanations, missing baseline, errors, clipboard fallback, run/cancel, approval guards, keyboard wipe and reduced motion',
  );
}
async function change(page, update) {
  await page.evaluate((value) => {
    if (value.runId) globalThis.__juxFixture.report.runId = value.runId;
    if (value.result)
      Object.assign(globalThis.__juxFixture.report.results[0], value.result);
  }, update);
}
async function click(page, label) {
  await page.waitForFunction(
    (text) =>
      [...globalThis.document.querySelectorAll('button')].some(
        (b) =>
          b.textContent.trim() === text &&
          !b.matches(':disabled, [aria-disabled="true"]'),
      ),
    label,
  );
  await page.evaluate(
    (text) =>
      [...globalThis.document.querySelectorAll('button')]
        .find(
          (b) =>
            b.textContent.trim() === text &&
            !b.matches(':disabled, [aria-disabled="true"]'),
        )
        .click(),
    label,
  );
}
async function textAppears(page, text) {
  await page
    .waitForFunction(
      (value) => globalThis.document.body.textContent.includes(value),
      text,
    )
    .catch((error) => {
      throw new Error(`Waiting for text "${text}": ${error.message}`);
    });
}
async function buttonExists(page, label) {
  return page.evaluate(
    (text) =>
      [...globalThis.document.querySelectorAll('button')].some(
        (b) => b.textContent.trim() === text,
      ),
    label,
  );
}
