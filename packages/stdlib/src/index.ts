import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

// NOTE: Where the standard library's Essence sources live. Resolved off this
// module's own location rather than the working directory — the same trick the
// Rewriter's `internalImport` uses for the runtime modules — so `esc` finds it
// from any cwd, and a bundle finds it beside itself. It is computed HERE, in
// the package that owns the files, rather than by a consumer counting `../`s
// towards them: whoever holds the sources is the one who can answer where they
// are, and moving them stays a change to one line in one package.
export const STDLIB_DIRECTORY = path.resolve(import.meta.dirname, "../sources")

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
	if (!existsSync(STDLIB_DIRECTORY)) {
		return []
	}

	return readdirSync(STDLIB_DIRECTORY)
		.filter((fileName) => fileName.endsWith(".es"))
		.sort()
		.map((fileName) => {
			let filePath = path.resolve(STDLIB_DIRECTORY, fileName)

			return { filePath, sourceText: readFileSync(filePath, "utf-8") }
		})
}
