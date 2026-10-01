import { format } from "node:util"

// How running a bundle's code in this process redirects its output and reports
// what it throws. A leaf, so the mutant Worker can use it without importing
// `test.ts`.

// While bundles load and run, stdout is pointed at stderr. A Module's top-level
// output belongs to no test, and stdout carries the report or the events.
// `console.log` is redirected too, because under Bun it writes straight to the
// file descriptor and `Terminal.inspect` writes through it. Writing through
// `process.stderr.write` lets a spec or a parent see it with everything else.
export function redirectStdout(): () => void {
	let original = process.stdout.write
	let log = console.log

	process.stdout.write = ((
		chunk: string | Uint8Array,
		...rest: Array<unknown>
	) =>
		(
			process.stderr.write as unknown as (
				value: string | Uint8Array,
				...args: Array<unknown>
			) => boolean
		)(chunk, ...rest)) as typeof process.stdout.write

	console.log = ((...values: Array<unknown>) => {
		process.stderr.write(`${format(...values)}\n`)
	}) as typeof console.log

	return () => {
		process.stdout.write = original
		console.log = log
	}
}

// A thrown thing as a reader needs it: an Error's stack, or how anything else
// renders. The Language Server's `testWorker.ts` has a twin of this.
export function rendered(error: unknown): string {
	return error instanceof Error
		? (error.stack ?? error.message)
		: String(error)
}
