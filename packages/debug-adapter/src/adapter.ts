import {
	type AdapterOptions,
	EssenceDebugSession,
} from "./session"

export {
	type CompileDiagnostic,
	type CompileFunction,
	type CompileResult,
	compileViaCli,
} from "./compile"
export { adapterCapabilities, EssenceDebugSession } from "./session"
export type { AdapterOptions }

// NOTE: One DAP session over stdio — exactly what a `DebugAdapterExecutable`
// spawn, or `DebugClient` in a spec, expects to find on the other end. stdout
// is the protocol channel, so nothing in the adapter may ever print to it;
// logging belongs on stderr.
export function startAdapter(options: AdapterOptions = {}): void {
	let session = new EssenceDebugSession(options)

	process.on("SIGTERM", () => session.shutdown())
	session.start(process.stdin, process.stdout)
}
