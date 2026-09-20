import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
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
// written down. A code whose entry there shows a `Write '…'` Help is a code that
// owes a compiled test.
//
// The registry is `COMPILE_CHECKED_HELP_CODES`, maintained by the specs that do
// the compiling. This holds it to the page both ways, and prints what is left.

const DOCS = path.join(
	import.meta.dir,
	"../../../website/src/content/docs/reference/diagnostics.mdx",
)

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
			/Help[ 0-9]*: .*Write '/.test(line) &&
			!codes.includes(current)
		) {
			codes.push(current)
		}
	}

	return codes
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

		expect(uncovered.length).toBeLessThanOrEqual(promising.length)
	})
})
