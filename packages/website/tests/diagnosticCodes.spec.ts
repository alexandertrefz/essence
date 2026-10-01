import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

// Every `DiagnosticCode` must be documented, since every report prints its
// code. The union in `interfaces/common` is read from source, since string
// literal unions leave nothing to iterate at run time.

// The published page, read as a file, as a reader following a code finds it.
const DIAGNOSTICS_PAGE = path.resolve(
	import.meta.dirname,
	"../src/content/docs/reference/diagnostics.mdx",
)

// The codes only the experimental test modes report: benchmarks, contracts
// and mutation runs. The site documents none of those modes, so these are
// neither required nor allowed on the page. Listed by prefix where possible.
const EXPERIMENTAL_PREFIXES = ["benchmark-", "contract-", "mutation-"]
const EXPERIMENTAL_CODES = new Set([
	"ungeneratable-contract",
	// Held back the same way: the typed record literal `Type ~> { … }` is left
	// undocumented while it goes unchecked, so its code is too.
	"record-annotation-not-record",
])

function isExperimental(code: string): boolean {
	return (
		EXPERIMENTAL_CODES.has(code) ||
		EXPERIMENTAL_PREFIXES.some((prefix) => code.startsWith(prefix))
	)
}

function declaredCodes(): Array<string> {
	// Resolved as a module rather than as a relative path into another
	// package.
	let source = readFileSync(
		fileURLToPath(import.meta.resolve("@essence-lang/interfaces/common")),
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
	let documentation = readFileSync(DIAGNOSTICS_PAGE, "utf8")

	return [...documentation.matchAll(/^### `([^`]+)`$/gm)].map(
		(match) => match[1],
	)
}

describe("Diagnostic Codes", () => {
	it("should find every declared code", () => {
		// A guard on the parsing: a regex that stopped matching would turn this
		// gate into a no-op.
		expect(declaredCodes().length).toBeGreaterThan(50)
		expect(documentedCodes().length).toBeGreaterThan(50)
	})

	it("should document every declared code but the experimental ones", () => {
		let documented = new Set(documentedCodes())
		let undocumented = declaredCodes().filter(
			(code) => !isExperimental(code) && !documented.has(code),
		)

		expect(undocumented).toEqual([])
	})

	it("should not document codes that no longer exist", () => {
		let declared = new Set(declaredCodes())
		let stale = documentedCodes().filter((code) => !declared.has(code))

		expect(stale).toEqual([])
	})

	it("should not document an experimental code", () => {
		expect(documentedCodes().filter(isExperimental)).toEqual([])
	})

	it("should allow only codes that exist by name", () => {
		// An exception must name a real code, or it would silently excuse the
		// next code given that name.
		let declared = new Set(declaredCodes())

		expect(
			[...EXPERIMENTAL_CODES].filter((code) => !declared.has(code)),
		).toEqual([])
	})

	it("should not declare a code twice", () => {
		let codes = declaredCodes()

		expect(codes).toEqual([...new Set(codes)])
	})

	it("should not document a code twice", () => {
		let codes = documentedCodes()

		expect(codes).toEqual([...new Set(codes)])
	})
})
