// NOTE: The bundle entry point for the editor extensions. `bin/esls` runs the
// Server directly with Bun; this exists because a bundler needs a module with
// a recognisable extension, which the shebang launcher deliberately is not.
import { startServer } from "./server"

startServer()
