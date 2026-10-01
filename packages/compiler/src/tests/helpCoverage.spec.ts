import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import type { common } from "@essence-lang/interfaces"

import { COMPILE_CHECKED_HELP_CODES } from "./followedHelps"

// A Help that tells the reader to write a spelling promises that the spelling
// compiles, and only compiling it keeps the promise. The codes that owe such a
// test are read off the reference page, which is captured from the real
// Compiler. This spec holds `COMPILE_CHECKED_HELP_CODES` to the page both ways
// and prints the codes left to compile.

const DOCS = path.join(
	import.meta.dir,
	"../../../website/src/content/docs/reference/diagnostics.mdx",
)

// A Help spells something when it says `Write '…'` or quotes code, such as
// "Add 'case Colour#Blue'" or `'<Item is Comparable>'`. Quoted code holds a
// separator, a bracket, a sigil, a path or a digit, while a quoted bare word
// such as 'Red' is prose. The pattern errs towards catching too much.
const SPELLS_SOMETHING =
	/Help[ 0-9]*: .*(?:[Ww]rite '|'[^']*(?:::|->|<-|[#(){}[\]=@.\\/<>]|[0-9])[^']*')/

// A `### \`code\`` heading opens an entry, and each `Help:` line until the
// next heading belongs to that code.
function codesPromisingASpelling(): Array<common.DiagnosticCode> {
	let codes: Array<common.DiagnosticCode> = []
	let current: common.DiagnosticCode | null = null

	for (let line of readFileSync(DOCS, "utf8").split("\n")) {
		let heading = /^### `([a-z0-9-]+)`/.exec(line)

		if (heading !== null) {
			current = heading[1] as common.DiagnosticCode

			continue
		}

		if (
			current !== null &&
			SPELLS_SOMETHING.test(line) &&
			!codes.includes(current)
		) {
			codes.push(current)
		}
	}

	return codes
}

// The specs that import `compiles` from `followedHelps`. Each registry entry
// must be written in one of them, so deleting the spec that earned an entry
// fails here. The suite runs one process per file, so a registry filled in at
// run time would be empty here. The specs are read as text instead.
function specsCompilingHelps(): Array<{
	name: string
	source: string
}> {
	return readdirSync(import.meta.dir)
		.filter((name) => name.endsWith(".spec.ts"))
		.sort()
		.map((name) => ({
			name,
			source: readFileSync(path.join(import.meta.dir, name), "utf8"),
		}))
		.filter(({ source }) => {
			let importing =
				/import \{([\s\S]*?)\} from "\.\/followedHelps"/.exec(source)

			return (
				importing !== null &&
				/\bcompiles\b/.test(importing[1] as string)
			)
		})
}

describe("Helps that spell something to write", () => {
	let promising = codesPromisingASpelling()

	it("finds them on the reference page", () => {
		expect(promising.length).toBeGreaterThan(20)
	})

	// An entry whose code prints no spelling to write claims a promise nobody
	// makes.
	it("has a registry with nothing stale in it", () => {
		expect(
			COMPILE_CHECKED_HELP_CODES.filter(
				(code) => !promising.includes(code),
			),
		).toEqual([])
	})

	// An entry no spec that compiles Helps writes down has nothing behind it,
	// as after the spec that compiled it is deleted or renamed.
	it("has every entry written down in a spec that compiles Helps", () => {
		let specs = specsCompilingHelps()

		expect(specs.map((spec) => spec.name).length).toBeGreaterThan(0)
		expect(
			COMPILE_CHECKED_HELP_CODES.filter(
				(code) =>
					!specs.some((spec) => spec.source.includes(`"${code}"`)),
			),
		).toEqual([])
	})

	// Printed rather than failed: an uncovered code is a Help that nothing
	// compiles yet, which is work to do rather than breakage.
	it("names what is left to compile", () => {
		let uncovered = promising.filter(
			(code) => !COMPILE_CHECKED_HELP_CODES.includes(code),
		)

		if (uncovered.length > 0) {
			console.log(
				`TODO — Helps that spell an edit and are not compiled anywhere (${uncovered.length}):\n  ${uncovered.join("\n  ")}`,
			)
		}
	})
})
