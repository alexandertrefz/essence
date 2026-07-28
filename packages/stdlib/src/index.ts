import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

// NOTE: Where the standard library's Essence sources live. Resolved off this
// module's own location rather than the working directory, so `esc` finds them
// from any cwd. Computed HERE, in the package that owns the files, rather than
// by a consumer counting `../`s towards them: whoever holds the sources is the
// one who can answer where they are.
//
// NOTE: Two layouts, because this module is read in two situations that do not
// look alike. Run from the workspace — `esc`, `esls`, the test suite — it sits
// in `packages/stdlib/src/` and the sources are its sibling. Run from a BUNDLE
// it does not: the Language Server inside the VS Code extension is one file,
// `import.meta.dirname` is wherever that file was written, and the sources have
// to have been copied next to it. They cannot be inlined instead — the loader
// finds them with `readdirSync`, and no bundler can see through that.
//
// This is what the extension shipped broken. `../sources` resolved to a
// directory that was not there, the loader answered with no sources at all,
// and the editor then reported every standard library Method as missing —
// `"hi"::uppercase()` came back as "No Namespace provides Methods for this
// value". So `build:server` copies the sources beside the bundle, and this
// finds them there.
const WORKSPACE_SOURCES = path.resolve(import.meta.dirname, "../sources")
const BUNDLED_SOURCES = path.resolve(import.meta.dirname, "stdlib")

export const STDLIB_DIRECTORY = existsSync(WORKSPACE_SOURCES)
	? WORKSPACE_SOURCES
	: BUNDLED_SOURCES

export type StdlibFile = {
	filePath: string
	sourceText: string
}

// NOTE: Sorted, so that the order files are hoisted and enriched in is the
// same on every machine — hoisting is order-independent by design, but a
// Diagnostic's file attribution should not depend on directory iteration order.
//
// NOTE: Reading is separated from parsing because parsing needs the Parser,
// and the Parser is the Compiler. This package holds fifteen `.es` files and
// knows where they are; what they mean is the Compiler's question.
export function readStdlibFiles(): Array<StdlibFile> {
	let fileNames = existsSync(STDLIB_DIRECTORY)
		? readdirSync(STDLIB_DIRECTORY)
				.filter((fileName) => fileName.endsWith(".es"))
				.sort()
		: []

	// NOTE: Loud, because the quiet version of this cost a shipped release.
	// Answering with no sources is not a degraded standard library, it is no
	// standard library — every Type and every Method a Program can reach is
	// declared in these files. What the user then sees is not "the standard
	// library is missing" but "No Namespace provides Methods for this value"
	// against `"hi"::uppercase()`, which reads like a bug in their code. There
	// is no situation where continuing is better than saying which directory
	// was looked in and stopping.
	if (fileNames.length === 0) {
		throw new Error(
			`The standard library is missing: no '.es' sources under '${STDLIB_DIRECTORY}'.\n\n` +
				"In a workspace checkout they are 'packages/stdlib/sources'. In a\n" +
				"bundle they have to be copied beside it — see the 'copy:stdlib'\n" +
				"script in the VS Code extension.",
		)
	}

	return fileNames.map((fileName) => {
		let filePath = path.resolve(STDLIB_DIRECTORY, fileName)

		return { filePath, sourceText: readFileSync(filePath, "utf-8") }
	})
}
