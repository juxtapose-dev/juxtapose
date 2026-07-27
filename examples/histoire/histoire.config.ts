import { defineConfig } from 'histoire';
import { HstVue } from '@histoire/plugin-vue';

export default defineConfig({
  plugins: [HstVue()],
  setupFile: './histoire/setup.ts',
  // juxtapose walks the Vite build manifest to work out which stories a change
  // could have affected.
  vite: {
    build: { manifest: true },
  },
});
