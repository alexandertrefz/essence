import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// NOTE: What every spec that drives the command line END TO END needs, and
// nothing else: a throwaway project on disk, and a hold on the two streams the
// CLI writes to. Both were spelled twice, once in `testRunner.spec` and once in
// `mutation.spec`, and two copies of a harness are two chances for a spec to be
// asking a slightly different question than the one beside it.

// NOTE: A project written into a fresh directory and removed afterwards,
// whatever the body did. The prefix is the caller's so that a directory left
// behind by a crash still says which suite made it.
export async function withFiles<Value>(
	files: Record<string, string>,
	body: (directory: string) => Promise<Value>,
	prefix = "essence-cli-",
): Promise<Value> {
	let directory = mkdtempSync(path.join(tmpdir(), prefix))

	try {
		for (let [fileName, source] of Object.entries(files)) {
			let filePath = path.join(directory, fileName)

			mkdirSync(path.dirname(filePath), { recursive: true })
			writeFileSync(filePath, source)
		}

		return await body(directory)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

// NOTE: Everything the CLI writes goes through `process.stdout` and
// `process.stderr`, so driving `run` from a spec means holding both for the
// length of the call — including the window in which the runner points stdout
// at stderr while a bundle is loading.
export async function capture(
	invoke: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
	let out = ""
	let err = ""
	let writeOut = process.stdout.write
	let writeErr = process.stderr.write

	process.stdout.write = ((chunk: string): boolean => {
		out += chunk

		return true
	}) as typeof process.stdout.write
	process.stderr.write = ((chunk: string): boolean => {
		err += chunk

		return true
	}) as typeof process.stderr.write

	try {
		return { code: await invoke(), out, err }
	} finally {
		process.stdout.write = writeOut
		process.stderr.write = writeErr
	}
}

// NOTE: A project's settings are read out of the nearest package.json, found by
// walking up from the WORKING DIRECTORY — so a spec about a configured project
// has to stand in one. Restored before `withFiles` removes the directory, which
// is why the two are nested rather than folded together.
export async function within<Value>(
	directory: string,
	body: () => Promise<Value>,
): Promise<Value> {
	let previous = process.cwd()

	process.chdir(directory)

	try {
		return await body()
	} finally {
		process.chdir(previous)
	}
}
