import * as path from "node:path"

import { canonicalPath, isStdlibDocument } from "../documents"

// NOTE: A specifier is a relative path including the `.es` extension, and
// nothing else — no bare name, no absolute path, no directory that a file name
// is guessed inside of. What a Module names is exactly what is read, so the
// dependency of a file can be found by anyone reading it, without knowing where
// a resolver would have looked.
//
// NOTE: Why a rejection is a reason rather than a Diagnostic: the Position a
// Diagnostic needs belongs to the `ModuleSpecifierNode` the specifier was
// written on, and the resolver is handed the text alone — the graph holds the
// Node, so the graph does the reporting.
export type SpecifierRejection =
	| "absolute"
	| "not-relative"
	| "missing-extension"
	| "standard-library"
	| "self-import"

export type SpecifierResolution =
	| { kind: "module"; filePath: string }
	| { kind: "rejected"; reason: SpecifierRejection }

// NOTE: How a specifier becomes a path, as a parameter. `resolveSpecifier` below
// is the one every user Program is built with; the standard library hands in its
// own, because its sources are already parsed and in memory and it must resolve
// against that set rather than against the file system — and because the rule
// below deliberately refuses a specifier that lands inside it.
export type SpecifierResolver = (
	specifier: string,
	importerPath: string,
) => SpecifierResolution

// NOTE: The one spelling of a path every other spelling of it agrees with is
// what makes one file one Module, so it is answered by `documents.ts` rather
// than by a rule of this stage's own: two paths for one file would be two
// Modules — parsed twice, enriched twice, and their Types not interchangeable.
// Re-exported because a Module's canonical path is its identity, and every
// caller of this stage keys on it.
export { canonicalPath }

// NOTE: Resolved against the importer's own directory rather than the working
// directory, so a specifier means the same thing however `esc` was invoked and
// wherever the Editor's process happens to be rooted.
export function resolveSpecifier(
	specifier: string,
	importerPath: string,
): SpecifierResolution {
	if (path.isAbsolute(specifier)) {
		return { kind: "rejected", reason: "absolute" }
	}

	if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
		return { kind: "rejected", reason: "not-relative" }
	}

	if (!specifier.endsWith(".es")) {
		return { kind: "rejected", reason: "missing-extension" }
	}

	let importer = canonicalPath(importerPath)
	let filePath = canonicalPath(
		path.resolve(path.dirname(importer), specifier),
	)

	if (filePath === importer) {
		return { kind: "rejected", reason: "self-import" }
	}

	// NOTE: Asked of `documents.ts` rather than compared against a path of this
	// stage's own, because that answer already resolves the two layouts the
	// standard library ships in — `packages/stdlib/sources` in a workspace, and
	// the copy written beside the bundled Language Server in the VS Code
	// extension. Hardcoding either one is what shipped the extension broken.
	if (isStdlibDocument(filePath)) {
		return { kind: "rejected", reason: "standard-library" }
	}

	return { kind: "module", filePath }
}
