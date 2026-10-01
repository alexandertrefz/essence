import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// What every spec driving the command line end to end needs: a throwaway project
// on disk, and a hold on the CLI's two streams.

// A project written into a fresh directory and removed afterwards, whatever the
// body did. The caller's prefix names the suite a crash's leftovers belong to.
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

// Holds `process.stdout` and `process.stderr` for the call, including while the
// runner points stdout at stderr as a bundle loads.
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

// Runs in a directory, since a project's settings are found by walking up from
// the working directory. It restores the directory before `withFiles` removes it.
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
