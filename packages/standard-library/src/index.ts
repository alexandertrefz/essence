import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

// Where the standard library's Essence sources live, resolved from this module
// so any working directory works. In the workspace they are the sibling
// `sources` directory. A bundle, such as the VS Code extension's server, must
// have them copied beside it, since the loader lists them with `readdirSync`.
const WORKSPACE_SOURCES = path.resolve(import.meta.dirname, "../sources")
const BUNDLED_SOURCES = path.resolve(import.meta.dirname, "standard-library")

export const STDLIB_DIRECTORY = existsSync(WORKSPACE_SOURCES)
	? WORKSPACE_SOURCES
	: BUNDLED_SOURCES

export type StdlibFile = {
	filePath: string
	sourceText: string
}

// Sorted, so a Diagnostic's file attribution never depends on directory order.
// Parsing is the Compiler's job, so this package only reads the files.
export function readStdlibFiles(): Array<StdlibFile> {
	let fileNames = existsSync(STDLIB_DIRECTORY)
		? readdirSync(STDLIB_DIRECTORY)
				.filter((fileName) => fileName.endsWith(".es"))
				.sort()
		: []

	// No sources means no standard library at all, which would surface as
	// confusing errors in the user's own code. So this stops and names the
	// directory it searched.
	if (fileNames.length === 0) {
		throw new Error(
			`The standard library is missing: no '.es' sources under '${STDLIB_DIRECTORY}'.\n\n` +
				"In a workspace checkout they are 'packages/standard-library/sources'. In a\n" +
				"bundle they have to be copied beside it — see 'buildServer.js'\n" +
				"in the VS Code extension.",
		)
	}

	return fileNames.map((fileName) => {
		let filePath = path.resolve(STDLIB_DIRECTORY, fileName)

		return { filePath, sourceText: readFileSync(filePath, "utf-8") }
	})
}
