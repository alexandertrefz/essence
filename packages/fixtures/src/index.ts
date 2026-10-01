import * as path from "node:path"

// Where the Essence sources the test suite compiles live, resolved from this
// module rather than the working directory. So a spec in any package finds them,
// wherever `bun test` runs.
export const FIXTURES_DIRECTORY = path.resolve(import.meta.dirname, "../files")

// Segments rather than one string, so call sites pick no separator.
// `fixturePath("diagnostics", "Syntax.es")` reads like the directory it names.
export function fixturePath(...segments: Array<string>): string {
	return path.join(FIXTURES_DIRECTORY, ...segments)
}
