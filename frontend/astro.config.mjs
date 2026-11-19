// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  vite: {
    // Workers load these entry points lazily. Discovering them after file selection
    // otherwise causes a dev-server reload that discards the selected File objects.
    optimizeDeps: {
      include: [
        '@time-estimator/browser-preview',
        '@time-estimator/browser-preview/pose',
        '@time-estimator/browser-preview/geometry',
        '@time-estimator/browser-preview/three',
        '@time-estimator/browser-preview/worker',
        '@time-estimator/browser-preview/stl',
        '@time-estimator/browser-preview/fast',
      ],
    },
  },
});
