import { juxtaposeModuleGraph } from '@juxtapose/core/vite';

export default {
  plugins: [
    // Records which source modules each story imports, so `jux run --since`
    // captures the stories a change reaches instead of all of them. Ladle has
    // no addon to add this, so it goes here.
    juxtaposeModuleGraph(),
  ],
};
