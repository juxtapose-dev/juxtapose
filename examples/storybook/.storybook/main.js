export default {
  stories: ['../stories/**/*.stories.jsx'],
  framework: { name: '@storybook/react-vite', options: {} },
  addons: ['@juxtapose/storybook-addon'],

  viteFinal: (config) => ({
    ...config,
    // The shared components package is plain JSX with no React import, so the
    // automatic runtime has to be on for files outside this app's own root.
    esbuild: { ...config.esbuild, jsx: 'automatic' },

    // juxtapose walks the Vite build manifest to work out which stories a
    // change could have affected. Without this it can still run, but it has no
    // graph to consult and conservatively captures everything.
    build: { ...config.build, manifest: true },
  }),
};
