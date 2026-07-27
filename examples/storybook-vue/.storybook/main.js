export default {
  stories: ['../stories/**/*.stories.js'],
  framework: { name: '@storybook/vue3-vite', options: {} },
  addons: ['@juxtapose/storybook'],

  // juxtapose walks the Vite build manifest to work out which stories a change
  // could have affected.
  viteFinal: (config) => ({
    ...config,
    build: { ...config.build, manifest: true },
  }),
};
