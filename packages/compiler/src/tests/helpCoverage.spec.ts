import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import type { common } from "@essence-lang/interfaces"

import { COMPILE_CHECKED_HELP_CODES } from "./followedHelps"

// NOTE: The second guard the Help audit left behind, and the smaller one. A Help
// that tells the reader to WRITE a spelling is a promise about that spelling, and
// the audit found the promise broken a dozen ways — a Type nothing declares, a
// Method with no such name, a Case with no payload where one was written. The
// only way to keep it is to compile what the Help printed.
//
// Prose is not parsed to find them: what is read is the reference page, which is
// captured from the real Compiler and is the one place every code's real text is
// written down. A code whose entry there shows a Help with a spelling in it is a
// code that owes a compiled test.
//
// The registry is `COMPILE_CHECKED_HELP_CODES`, maintained by the specs that do
// the compiling. This holds it to the page both ways, and prints what is left.

const DOCS = path.join(
	import.meta.dir,
	"../../../website/src/content/docs/reference/diagnostics.mdx",
)

// NOTE: What a Help that SPELLS something looks like on the page. It used to be
// the word "Write" followed by a quote, which is one of the shapes a Help takes
// and not the one most of them take: the audit's review counted 39 codes that
// print code inside a Help this could not see — "Add 'case Colour#Blue'", "Take
// the payload apart instead: '#Rectangle({ width, height })'", "Compare instead:
// 'body::is("…")'" — and every one of them is a promise about a spelling in
// exactly the way `Write '…'` is.
//
// Angle brackets are in that list for the same reason: `'<Item is Comparable>'`
// is a Type Parameter list, which is as much a spelling as a call is, and the
// Helps about bounds are written with the word `write` in the middle of a
// sentence as often as at the start of one.
//
// So: a quoted run that reads as CODE rather than as an English aside. Code is
// what holds a separator, a bracket, a sigil, a path or a digit; a Help that
// quotes a bare word ("Remove this 'Red'") is left out unless it says to write
// it. The line between the two is not a sharp one, and it is drawn on the side
// of catching too much — an entry on the printed list that turns out to be
// prose costs a reader one look, and one that is missing costs them the promise.
const SPELLS_SOMETHING =
	/Help[ 0-9]*: .*(?:[Ww]rite '|'[^']*(?:::|->|<-|[#(){}[\]=@.\\/<>]|[0-9])[^']*')/

// NOTE: Read off the captured reports rather than off the prose around them —
// a `### \`code\`` heading opens an entry, and every `Help:` line under it until
// the next heading belongs to that code.
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

// NOTE: The specs that compile what a Help spells — the ones importing
// `compiles` from the shared harness. The registry is a list of codes and
// nothing holds a list of codes to anything, so what is checked is that each
// entry is WRITTEN DOWN in one of these: delete the spec that earned an entry
// and the entry fails here rather than going on claiming a test that is gone.
//
// Registration at run time would say it better — the spec that compiles a Help
// would record its code as it ran — but the suite runs one process per file, so
// a registry filled in by `choices.spec.ts` is empty by the time this file reads
// it. Reading the specs as text is what survives `--parallel`.
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

	// NOTE: An entry whose code no longer prints a spelling to write is an entry
	// about a Help that is gone — the registry would go on claiming a promise
	// nobody is making, which is the way a list like this rots.
	it("has a registry with nothing stale in it", () => {
		expect(
			COMPILE_CHECKED_HELP_CODES.filter(
				(code) => !promising.includes(code),
			),
		).toEqual([])
	})

	// NOTE: An entry whose code is written down in no spec that compiles a Help
	// is an entry with nothing behind it — the registry would go on saying a
	// Help is compiled somewhere after the spec that compiled it was deleted or
	// renamed, which is the one thing a registry maintained by hand does on its
	// own.
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

	// NOTE: Printed rather than failed, deliberately. The uncovered codes are
	// work, not breakage: each is a Help that WORKS as far as anybody has
	// checked and that nothing compiles, and turning the list red would only
	// mean deleting it. The Compiler's own behaviour is guarded above.
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
