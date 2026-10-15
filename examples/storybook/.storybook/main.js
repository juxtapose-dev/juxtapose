export default {
  stories:
    process.env.JUX_PROFILE_STORIES === '1'
      ? ['../profiling/**/*.stories.jsx']
      : ['../stories/**/*.stories.jsx'],
  framework: { name: '@storybook/react-vite', options: {} },
  addons: ['@juxtapose/storybook'],

  viteFinal: (config) => ({
    ...config,
    // The shared components package is plain JSX with no React import, so the
    // automatic runtime has to be on for files outside this app's own root.
    esbuild: { ...config.esbuild, jsx: 'automatic' },

    // The addon records the module graph `jux run --since` uses to pick the
    // stories a change reaches. Vite's own manifest is optional now: only
    // `cause` (why a story changed) still reads it.
    build: {
      ...config.build,
      manifest: true,
      ...(process.env.JUX_PROFILE_STORIES === '1' ? { assetsInlineLimit: 0 } : {}),
    },
  }),
};
