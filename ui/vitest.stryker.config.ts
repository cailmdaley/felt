import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vite.config'

/**
 * The Chronicle feed-and-ledger contract's test files, for mutation runs.
 *
 * `stryker.chronicle.config.json` points StrykerJS here. Stryker is not a
 * dependency of this package; with `@stryker-mutator/core` and
 * `@stryker-mutator/vitest-runner` installed alongside a vitest that resolves
 * to this package's own:
 *
 *   TZ=America/Los_Angeles stryker run stryker.chronicle.config.json
 *   node scripts/mutation-subsumption.mjs reports/mutation/chronicle.json
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: [
        'src/board/views/chronicleFeeds.test.ts',
        'src/board/views/chronicleJoin.test.ts',
        'src/board/views/temporalData.test.ts',
        'src/board/views/vocabulary.test.ts',
      ],
    },
  }),
)
