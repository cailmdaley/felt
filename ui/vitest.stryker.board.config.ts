import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import base from './vite.config'

/**
 * The whole board suite, for `stryker.board.config.json`. Left out: the
 * lifecycle-model test, which reads the daemon's fixture outside `ui/` that
 * Stryker's sandbox does not copy, and the source guards, which read source
 * files that Stryker has instrumented. Properties get a minute each, since
 * instrumented code runs several times slower.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      testTimeout: 60_000,
      exclude: [
        ...configDefaults.exclude,
        'test/lifecycleModel.test.ts',
        'test/typeRoles.test.ts',
        'test/paletteLiterals.test.ts',
        'test/deskNoHover.test.ts',
      ],
    },
  }),
)
