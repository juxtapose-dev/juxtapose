// Screenshot every story with jest-image-snapshot after it renders.
//   BENCH_SNAP_DIR  where baselines live (required)
//   BENCH_MODE      'default' (jest-image-snapshot defaults: pixelmatch
//                   threshold 0.01, failureThreshold 0) or 'zero'
//                   (pixelmatch threshold 0, failureThreshold 0)
const path = require('node:path');
const { toMatchImageSnapshot } = require('jest-image-snapshot');

const snapDir = process.env.BENCH_SNAP_DIR;
if (!snapDir) throw new Error('BENCH_SNAP_DIR is required');
const zero = process.env.BENCH_MODE === 'zero';

module.exports = {
  setup() {
    expect.extend({ toMatchImageSnapshot });
  },
  async postVisit(page, context) {
    const image = await page.screenshot();
    expect(image).toMatchImageSnapshot({
      customSnapshotsDir: path.resolve(snapDir),
      customDiffDir: path.resolve(snapDir, '__diff__'),
      customSnapshotIdentifier: context.id,
      failureThreshold: 0,
      failureThresholdType: 'pixel',
      ...(zero ? { customDiffConfig: { threshold: 0 } } : {}),
    });
  },
};
