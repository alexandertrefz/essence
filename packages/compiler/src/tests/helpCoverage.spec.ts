import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
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

const REPOSITORY = path.join(import.meta.dir, "../../../..")

// Some Helps are no edit to a Program, such as a path on the command line or a
// character `essence.json` lacks. `compiles` can not follow those, so each
// code names the spec that does, as a path from the repository root. That
// spec follows it in a `describe("followed")` block naming the code.
const FOLLOWED_WITHOUT_COMPILING: Readonly<
	Partial<Record<common.DiagnosticCode, string>>
> = {
	"file-not-found": "packages/cli/src/tests/cli.spec.ts",
	"not-a-file": "packages/cli/src/tests/cli.spec.ts",
	"unreadable-project-file":
		"packages/compiler/src/tests/configuration.spec.ts",
}

// A spec's `describe("followed")` block, read to the line that closes it at its
// own indentation, or null where the spec has none.
function followedBlockOf(source: string): string | null {
	let lines = source.split("\n")
	let start = lines.findIndex((line) =>
		/^\t*describe\("followed", \(\) => \{$/.test(line),
	)

	if (start === -1) {
		return null
	}

	let indentation = /^\t*/.exec(lines[start] as string)?.[0] ?? ""
	let end = lines.findIndex(
		(line, index) => index > start && line === `${indentation}})`,
	)

	return end === -1 ? null : lines.slice(start, end + 1).join("\n")
}

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

	it("has nothing stale among the codes followed without compiling", () => {
		expect(
			Object.keys(FOLLOWED_WITHOUT_COMPILING).filter(
				(code) => !promising.includes(code as common.DiagnosticCode),
			),
		).toEqual([])
	})

	// A code is followed one way, so it is never in both lists.
	it("follows each code without compiling only where nothing compiles it", () => {
		expect(
			COMPILE_CHECKED_HELP_CODES.filter(
				(code) => FOLLOWED_WITHOUT_COMPILING[code] !== undefined,
			),
		).toEqual([])
	})

	// Deleting the block that follows a code, or moving it to another spec,
	// fails here.
	it("has every code followed without compiling in its spec's followed block", () => {
		expect(
			Object.entries(FOLLOWED_WITHOUT_COMPILING).filter(
				([code, specPath]) => {
					let file = path.join(REPOSITORY, specPath as string)
					let block = existsSync(file)
						? followedBlockOf(readFileSync(file, "utf8"))
						: null

					return block === null || !block.includes(`"${code}"`)
				},
			),
		).toEqual([])
	})

	// Printed rather than failed: an uncovered code is a Help that nothing
	// follows yet, which is work to do rather than breakage.
	it("names what is left to compile", () => {
		let uncovered = promising.filter(
			(code) =>
				!COMPILE_CHECKED_HELP_CODES.includes(code) &&
				FOLLOWED_WITHOUT_COMPILING[code] === undefined,
		)

		if (uncovered.length > 0) {
			console.log(
				`TODO — Helps that spell an edit and are not followed anywhere (${uncovered.length}):\n  ${uncovered.join("\n  ")}`,
			)
		}
	})
})
