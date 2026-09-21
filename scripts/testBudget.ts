import { setDefaultTimeout } from "bun:test"

// NOTE: One budget for every spec in the repository, preloaded by `bunfig.toml`
// into each test process — the parallel runner's workers included. Most of what
// this suite does is COMPILE a Program and often run it, and how long that takes
// is a property of the host rather than of the code: Bun's default of five
// seconds is ample on an idle machine and is not a claim any test here makes.
// With several suites sharing the machine at a load of 30 to 80, tests that take
// well under a second alone were timing out at 5,002 ms in `codegenNaming`,
// `stdlibSearch`, `optimiser`, `codeActions` and the CLI's spawning specs, a
// different handful on every run and with nothing about the Compiler disproved.
// A timeout that fires while the thing it guards is still true is a flake, so
// the patience is a minute, and a test that truly hangs still fails — a minute
// later. A spec that CLAIMS a speed says so with a growth ratio or a count of
// the work done, never with this number.
//
// NOTE: A preload rather than `[test] timeout` in `bunfig.toml`, which Bun 1.4
// reads and then ignores — a test waiting 5.5 s under `timeout = 20000` still
// failed at 5,002 ms — and rather than `--timeout` on the `test` script, which
// would leave `bun test <one spec>` on the default. `setDefaultTimeout` covers
// `beforeAll` hooks as well as tests; both were tried.
setDefaultTimeout(60_000)
