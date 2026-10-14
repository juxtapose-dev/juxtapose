// Jest config for test-storybook: the stock config plus a 1280x800 viewport
// and, when BENCH_CHROME is set, a specific Chromium binary.
const { getJestConfig } = require('@storybook/test-runner');

const base = getJestConfig();
const jp = base.testEnvironmentOptions['jest-playwright'];
const launchOptions = { ...jp.launchOptions };
if (process.env.BENCH_CHROME) launchOptions.executablePath = process.env.BENCH_CHROME;

module.exports = {
  ...base,
  testEnvironmentOptions: {
    ...base.testEnvironmentOptions,
    'jest-playwright': {
      ...jp,
      launchOptions,
      contextOptions: { ...jp.contextOptions, viewport: { width: 1280, height: 800 } },
    },
  },
};
