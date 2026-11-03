import { defineConfig } from 'tsdown'

/**
 * Host build: emit `lib/index.js` so an installed package runs as plain ESM
 * under the DSH Loader. `@octokit/rest` and `zod` are ESM-only and stay
 * external, resolving through the package's own `node_modules`.
 *
 * `@gitbeaker/rest` is a devDependency and is bundled together with its
 * CommonJS dependency tree (`picomatch-browser`, `qs`, `rate-limiter-flexible`,
 * `xcase`, …). When a plugin upgrade rewrites files under `node_modules`, DSH
 * HMR evicts the changed modules from Node's ES module and CommonJS caches and
 * imports them again; Node then hands a re-imported CommonJS package whose
 * entry is `module.exports = require('./lib/…')` an empty `{}` instead of the
 * re-exported value, and every GitLab request failed with
 * `isGlobMatch is not a function`. With no CommonJS module left in the
 * runtime graph, replacement re-evaluates ES modules only.
 * `scripts/verify-host-loader.mjs` fails the check when a CommonJS module is
 * loaded again.
 */
export default defineConfig({
  name: 'dsh-repo/host',
  entry: { index: 'src/index.ts' },
  tsconfig: 'tsconfig.json',
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  external: [
    '@octokit/rest',
    'zod',
  ],
})
