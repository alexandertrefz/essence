// The bundle entry point for the editor extensions. `bin/esls` runs the
// Server with Bun, but a bundler needs a module with a file extension.
import { startServer } from "./server"

startServer()
