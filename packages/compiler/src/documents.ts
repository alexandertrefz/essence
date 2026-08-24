import { realpathSync } from "node:fs"
import path from "node:path"

import type { common, parser } from "@essence-lang/interfaces"
import { STDLIB_DIRECTORY } from "@essence-lang/standard-library"

import { enrich } from "./enricher/index"
import { declaredNames } from "./enricher/stdlib"
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

// NOTE: The one spelling of a path every other spelling of it agrees with.
// `path.resolve` is purely lexical — it flattens `.`/`..` and prefixes the
// working directory and stops there — while `realpathSync` is the system
// `realpath(3)`: it follows symlinks, and on a case-insensitive filesystem it
// answers in the casing the entry is stored under. A checkout opened through
// a symlink (`~/dev/essence` → the real directory) or spelled with different
// casing names the very files `STDLIB_DIRECTORY` names, byte-differently, and
// a byte-exact comparison would hand a genuine standard library source the
// strict user-file treatment below — for the whole Editor session. Where the
// filesystem IS case-sensitive, a differently cased path is a different file;
// leaving the casing to `realpath` keeps that true as well.
//
// The document need not exist on disk — an Editor holds files that have never
// been saved — so the deepest ancestor that DOES exist is canonicalised and
// the missing tail appended lexically.
//
// Module resolution answers with this too, so that the line drawn here and the
// identity of a Module are the same spelling of the same path: a second copy of
// this that canonicalised differently would let a Module and a standard library
// source disagree about which file they are.
export function canonicalPath(filePath: string): string {
	let resolved = path.resolve(filePath)
	let existing = resolved
	let missing: Array<string> = []

	while (true) {
		try {
			return path.join(realpathSync.native(existing), ...missing)
		} catch {}

		let parent = path.dirname(existing)

		// NOTE: The filesystem root is its own parent — there is nothing left
		// above it to resolve, so the lexical spelling is all there is.
		if (parent === existing) {
			return resolved
		}

		missing.unshift(path.basename(existing))
		existing = parent
	}
}

// NOTE: BOTH sides of the comparison are canonical. The module system handed
// this compiler its own location with symlinks already resolved, so
// `STDLIB_DIRECTORY` is canonical in practice — but nothing in its contract
// says so, and one un-canonicalised side is enough to lose every match.
// Resolved once: the standard library does not move while the process runs.
const CANONICAL_STDLIB_DIRECTORY = canonicalPath(STDLIB_DIRECTORY)

// NOTE: The Language Server is handed URIs
// (`file:///…/packages/standard-library/sources/List.es`) and the tests plain paths;
// both are matched, and a `%20` or the like is decoded first so a path with a
// space is not missed.
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

	return canonicalPath(filePath).startsWith(
		`${CANONICAL_STDLIB_DIRECTORY}${path.sep}`,
	)
}

// NOTE: Whether a directory a walk starts in IS the standard library: the
// sources directory, anything under it, or the package that holds it. It is a
// separate question from `isStdlibDocument`, which answers about a FILE and is
// what keeps a project's own walk from picking the library up. A walk of the
// library itself is the one place its sources are wanted — its `@example`
// blocks are tests, and `essence test` run in it is how they are run.
export function isStdlibWalk(directory: string): boolean {
	let resolved = canonicalPath(directory)

	return (
		resolved === CANONICAL_STDLIB_DIRECTORY ||
		resolved === path.dirname(CANONICAL_STDLIB_DIRECTORY) ||
		resolved.startsWith(`${CANONICAL_STDLIB_DIRECTORY}${path.sep}`)
	)
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

// NOTE: `tests` is the compile MODE, and the only way a `tests { … }` block
// becomes anything but parsed text. `essence build`, `essence run` and the
// Editor's ordinary analysis leave it off, so the block is read — a syntax
// error in it is still reported — and then dropped before enrichment, which is
// the whole of what "a test costs a shipped Program nothing" means.
export function enrichDocument(
	program: parser.Program,
	documentPath?: string,
	options: {
		annotations?: boolean
		tests?: boolean
		// NOTE: And whether it asked for the goals the document's own Namespace
		// declarations promise — see `enrich`'s own `contracts`. It means
		// nothing without `tests`.
		contracts?: boolean
		// NOTE: The document's own text, which only a test compile reads — an
		// `@example` block is compiled out of the file's own lines. See
		// `enrich`'s own `source`.
		source?: string
	} = {},
): {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
	annotations: Array<common.TypeAnnotation>
} {
	if (!isStdlibDocument(documentPath)) {
		return enrich(program, options)
	}

	// NOTE: Only the names THIS document declares are subtracted. A Namespace
	// another standard library file declares is a genuine builtin as far as
	// this one is concerned — the loader hoists them all into one Scope, and
	// the editor's view of a single file should agree.
	//
	// NOTE: A standard library source is not a Module, so its Scope names none
	// — and a test out of one still has to say which file it came from. The
	// path is handed over for the identities alone; the Scope's own
	// `modulePath` stays absent, which is what keeps the library's Choices
	// unqualified.
	return enrich(program, {
		...options,
		testsPath: documentPath,
		shadowedBuiltins: declaredNames([program]),
	})
}
