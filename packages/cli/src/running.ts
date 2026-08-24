import { format } from "node:util"

// NOTE: What running SOMEBODY ELSE'S code inside this process costs the process:
// where the output of it goes, and how what it throws is written down. Both are
// wanted by the test runner and by the mutant Worker, and a Worker may not
// import `test.ts` — that file reaches the compile pipeline, the report and the
// result cache, none of which a thread that loads one bundle and runs one test
// has any use for. So they live here, in a leaf that imports one thing from the
// standard library and nothing at all from this package.

// NOTE: A Module's own top-level output — a `Terminal.print` outside any test —
// is written by the bundle as it is evaluated: before any test is running, and
// with no test to attribute it to. It is not part of the report, and under
// --json stdout carries the event stream and nothing else — so for the length
// of the load and the run stdout is pointed at stderr, where the output still
// arrives and still streams. What a test itself writes never comes through
// here: the runtime captures it against the test and the report shows it with
// the failure.
//
// NOTE: `console.log` is pointed at stderr as well, and that is not belt and
// braces. `Terminal.inspect` renders a whole line and writes it through
// `console.log`, which under Bun goes to the file descriptor DIRECTLY and never
// through `process.stdout.write` — so a Module that inspects a value at its top
// level would put its rendering on stdout ahead of the first event, and a
// consumer parsing the stream a line at a time would die on it. It is written
// through `process.stderr.write` rather than through `console.error` so that
// whatever holds the two streams — a spec, a parent process — sees it where it
// sees everything else.
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

// NOTE: A thrown thing as a reader needs it — the stack where there is one,
// because what a mutant's bundle threw is only useful with the frames under it,
// and whatever the thing renders as where it is not an Error at all.
//
// NOTE: The Language Server's `testWorker.ts` holds a twin of this, spelled the
// same way, for the same reason and against a Worker of its own. The two
// packages share no leaf today; unifying them is worth doing when one of them
// next needs to change.
export function rendered(error: unknown): string {
	return error instanceof Error
		? (error.stack ?? error.message)
		: String(error)
}
