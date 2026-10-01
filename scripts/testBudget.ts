import { setDefaultTimeout } from "bun:test"

// One timeout for every spec, preloaded by `bunfig.toml` into each test
// process. Compiles take as long as a loaded host takes, so the budget is a
// minute. See "The test budget" in DEVELOPMENT.md.
setDefaultTimeout(60_000)
