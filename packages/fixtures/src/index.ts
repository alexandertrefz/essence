import * as path from "node:path"

// NOTE: Where the Essence sources the test suite compiles live. Resolved off
// this module's own location rather than the working directory — the same trick
// `enricher/stdlib.ts` uses for the standard library — so that a spec finds a
// fixture from whichever package it lives in, and `bun test` behaves the same
// run from the repository root or from inside a single package.
export const FIXTURES_DIRECTORY = path.resolve(import.meta.dirname, "../files")

// NOTE: Segments rather than one string so that call sites do not have to pick
// a separator, and so that `fixturePath("diagnostics", "Syntax.es")` reads the
// same way as the directory it names.
export function fixturePath(...segments: Array<string>): string {
	return path.join(FIXTURES_DIRECTORY, ...segments)
}
