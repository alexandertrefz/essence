import path from "node:path"

import { enrich } from "./enricher/index"
import { declaredNames, STDLIB_DIRECTORY } from "./enricher/stdlib"
import type { common, parser } from "./interfaces/index"
import { parseWithDiagnostics } from "./parser/index"

// NOTE: A standard library source is an ordinary `.es` file that two rules do
// not apply to, and the Language Server has to know which document it is
// looking at to lift them:
//
//   • it opens with `declarations { … }`, which every other file is forbidden
//     to. Parsed without that permission the header is rejected AND the rest
//     of the file mis-parses behind it — a body-less Method signature is not
//     valid in an `implementation` block, so `is(_ other: Boolean) -> Boolean`
//     comes back as a syntax error and everything downstream (Hover,
//     Completion, Rename) runs against a wrecked AST.
//
//   • its declarations are ALREADY in the builtin tables, because the loader
//     read this very file to put them there. Enriched against the untouched
//     tables, every single one is reported as a redeclaration of itself.
//
// Both are decided by WHERE the document lives — `declarations` outside the
// standard library is a real Diagnostic and has to keep firing. The
// String, Integer and Rational conversions are hundreds of hand transcribed
// Methods each, so the editor has to work inside these files.

// NOTE: The Language Server is handed URIs (`file:///…/src/stdlib/List.es`)
// and the tests plain paths; both are matched, and a `%20` or the like is
// decoded first so a path with a space is not missed.
//
// The document has to live in THE standard library — the one this compiler
// loads, resolved off the loader's own module — not merely in a directory
// spelled `src/stdlib`. Essence is a language: a user's own project may well
// have one, and matching by shape would tell them in their Editor that a
// `declarations { … }` block is fine while `esc` rejects it.
export function isStdlibDocument(documentPath: string | undefined): boolean {
	if (documentPath === undefined) {
		return false
	}

	let filePath = documentPath.startsWith("file://")
		? documentPath.slice("file://".length)
		: documentPath

	try {
		filePath = decodeURIComponent(filePath)
	} catch {}

	if (!filePath.endsWith(".es")) {
		return false
	}

	return path.resolve(filePath).startsWith(`${STDLIB_DIRECTORY}${path.sep}`)
}

export function parseDocument(
	source: string,
	documentPath?: string,
): {
	program: parser.Program
	diagnostics: Array<common.Diagnostic>
} {
	return parseWithDiagnostics(source, {
		allowDeclarationsHeader: isStdlibDocument(documentPath),
	})
}

export function enrichDocument(
	program: parser.Program,
	documentPath?: string,
): {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
} {
	if (!isStdlibDocument(documentPath)) {
		return enrich(program)
	}

	// NOTE: Only the names THIS document declares are subtracted. A Namespace
	// another standard library file declares is a genuine builtin as far as
	// this one is concerned — the loader hoists them all into one Scope, and
	// the editor's view of a single file should agree.
	return enrich(program, { shadowedBuiltins: declaredNames([program]) })
}
