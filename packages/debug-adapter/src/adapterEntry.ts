// NOTE: The bundle entry point for the editor extensions, mirroring the
// Language Server's `serverEntry.ts`. `bin/esdap` runs the adapter directly
// with Bun; this exists because a bundler needs a module with a recognisable
// extension, which the shebang launcher deliberately is not. It compiles by
// spawning the CLI — an extension bundle carries no compiler of its own.
import { startAdapter } from "./adapter"
import { compileViaCli } from "./compile"

startAdapter({ compile: compileViaCli() })
