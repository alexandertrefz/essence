import { realpathSync } from "node:fs"
import path from "node:path"

import type { common, parser } from "@essence-lang/interfaces"
import { STDLIB_DIRECTORY } from "@essence-lang/standard-library"

import type { CompileMode } from "./compileMode"
import { enrich } from "./enricher/index"
import { declaredNames } from "./enricher/stdlib"
import { parseWithDiagnostics } from "./parser/index"

// A standard library source may open with `declarations { … }`, and its
// declarations are builtins already. So it is parsed and enriched by where it
// lives, which the editor needs to know as much as the loader.

// The one spelling of a path that every other spelling agrees with, which
// Module identity uses too. `realpathSync` follows symlinks and answers in the
// stored casing. A missing tail is appended to the deepest existing ancestor.
export function canonicalPath(filePath: string): string {
	let resolved = path.resolve(filePath)
	let existing = resolved
	let missing: Array<string> = []

	while (true) {
		try {
			return path.join(realpathSync.native(existing), ...missing)
		} catch {}

		let parent = path.dirname(existing)

		// The root is its own parent, and nothing above it resolves.
		if (parent === existing) {
			return resolved
		}

		missing.unshift(path.basename(existing))
		existing = parent
	}
}

// Both sides of a comparison are canonical, since nothing promises that
// `STDLIB_DIRECTORY` is.
const CANONICAL_STDLIB_DIRECTORY = canonicalPath(STDLIB_DIRECTORY)

// Takes a `file://` URI or a path, decoded. The document must live in the
// standard library this compiler loads, not in any directory of that name, so
// the editor agrees with `esc`.
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

// Whether a walk starts in the standard library: its sources, anything under
// them, or the package holding them. Only such a walk wants the library's
// sources, whose `@example` blocks are tests.
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

// Unless a `CompileMode` asks for tests, a `tests { … }` block is parsed and
// then dropped before enrichment.
export function enrichDocument(
	program: parser.Program,
	documentPath?: string,
	options: CompileMode & {
		annotations?: boolean
		// Only a test compile reads it, for the `@example` blocks.
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

	// Only this document's names are subtracted, since every other library
	// file's are builtins here. `testsPath` names the file for test identities,
	// and the Scope keeps no `modulePath`, so Choices stay unqualified.
	return enrich(program, {
		...options,
		testsPath: documentPath,
		shadowedBuiltins: declaredNames([program]),
	})
}
