import { svelteComponentInstrumentation } from './svelte-components.js';

interface ComponentBuildConfig {
  define?: Record<string, unknown>;
  esbuild?: false | { keepNames?: boolean };
}

/** Retain React names at minification; enable Vue hooks and Svelte instrumentation. */
export function juxtaposeComponentEvidence(root = process.cwd()) {
  return [
    {
      name: 'juxtapose:component-evidence',
      config(config: ComponentBuildConfig) {
        return {
          // Vite applies this in the final esbuild minifier. Per-module transforms
          // deliberately disable keepNames to preserve tree-shaking.
          esbuild:
            config.esbuild === false
              ? (false as const)
              : { keepNames: config.esbuild?.keepNames ?? true },
          define: {
            __VUE_PROD_DEVTOOLS__: config.define?.__VUE_PROD_DEVTOOLS__ ?? 'true',
          },
        };
      },
    },
    svelteComponentInstrumentation(root),
  ];
}
