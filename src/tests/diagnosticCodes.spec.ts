import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

// NOTE: "Every DiagnosticCode is documented" is a completion gate, not an
// aspiration — the code is printed in every terminal report and handed to
// every Language Server client, and a code nobody can look up is worse than
// no code at all. The union in `interfaces/common` is the source of truth,
// read from source because a union of string literals leaves nothing behind
// at runtime to iterate.

const ROOT = path.join(import.meta.dir, "..", "..")

function declaredCodes(): Array<string> {
	let source = readFileSync(
		path.join(ROOT, "src", "interfaces", "common", "index.ts"),
		"utf8",
	)
	let union = source.match(
		/export type DiagnosticCode =\n((?:\t*(?:\|\s*"[^"]+"|\/\/.*)\n)+)/,
	)

	if (union === null) {
		throw new Error("Could not find the DiagnosticCode union")
	}

	return [...union[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

function documentedCodes(): Array<string> {
	let documentation = readFileSync(
		path.join(ROOT, "docs", "diagnostics.md"),
		"utf8",
	)

	return [...documentation.matchAll(/^### `([^`]+)`$/gm)].map(
		(match) => match[1],
	)
}

describe("Diagnostic Codes", () => {
	it("should find every declared code", () => {
		// NOTE: A guard on the parsing above — a regex that silently stops
		// matching would turn this whole gate into a no-op.
		expect(declaredCodes().length).toBeGreaterThan(50)
	})

	it("should document every declared code", () => {
		let documented = new Set(documentedCodes())
		let undocumented = declaredCodes().filter(
			(code) => !documented.has(code),
		)

		expect(undocumented).toEqual([])
	})

	it("should not document codes that no longer exist", () => {
		let declared = new Set(declaredCodes())
		let stale = documentedCodes().filter((code) => !declared.has(code))

		expect(stale).toEqual([])
	})

	it("should not declare a code twice", () => {
		let codes = declaredCodes()

		expect(codes).toEqual([...new Set(codes)])
	})
})
