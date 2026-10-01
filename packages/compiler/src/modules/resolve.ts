import * as path from "node:path"

import { canonicalPath, isStdlibDocument } from "../documents"

// A specifier is a relative path with its `.es` extension, so a reader finds a
// file's dependency without knowing where a resolver would look. A rejection
// is a reason, and the graph, which holds the Node, reports it.
export type SpecifierRejection =
	| "absolute"
	| "not-relative"
	| "missing-extension"
	| "standard-library"
	| "self-import"

export type SpecifierResolution =
	| { kind: "module"; filePath: string }
	| { kind: "rejected"; reason: SpecifierRejection }

// User Programs resolve with `resolveSpecifier`. The standard library hands in
// its own resolver, since its sources are in memory and `resolveSpecifier`
// refuses a path inside it.
export type SpecifierResolver = (
	specifier: string,
	importerPath: string,
) => SpecifierResolution

// A Module's canonical path is its identity, and every caller of this stage
// keys on it. Two paths for one file would make two Modules with distinct Types.
export { canonicalPath }

// Resolved against the importer's directory, so a specifier means the same
// whatever the working directory.
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

	// `isStdlibDocument` finds the standard library wherever it ships, as a
	// workspace's sources or beside the extension's bundled server.
	if (isStdlibDocument(filePath)) {
		return { kind: "rejected", reason: "standard-library" }
	}

	return { kind: "module", filePath }
}
