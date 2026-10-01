import { type AdapterOptions, EssenceDebugSession } from "./session"

export {
	type CompileDiagnostic,
	type CompileFunction,
	type CompileResult,
	compileViaCli,
} from "./compile"
export { adapterCapabilities, EssenceDebugSession } from "./session"
export type { AdapterOptions }

// One DAP session over stdio. stdout is the protocol channel, so the adapter
// never prints to it; logging goes to stderr.
export function startAdapter(options: AdapterOptions = {}): void {
	let session = new EssenceDebugSession(options)

	process.on("SIGTERM", () => session.shutdown())
	session.start(process.stdin, process.stdout)
}
