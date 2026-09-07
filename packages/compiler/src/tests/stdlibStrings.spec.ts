import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The String Methods written in Essence on the native searches —
// `contains`, `doesNotContain`, `replaceFirst` — run through the whole
// pipeline as `stdlibSearch.spec.ts` runs its Lists. What these guard
// is not observable at the Type level: an ASCII String and a String the scan
// refuses take two different routes through the runtime, and every answer
// below is asked over both, so that the two routes are held to one answer.
function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

async function run(source: string): Promise<Array<string>> {
	let js = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-strings-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, js)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((argument) => String(argument)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return output
}

// NOTE: A four-person family emoji — eleven code units joined by zero-width
// joiners, ONE character — spliced into the source so that the same question
// can be asked of a String the ASCII scan refuses. The Lexer knows no `\u`
// escape, so the JavaScript String carries the code points in.
const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}"

describe("Stdlib String bodies", () => {
	describe("String.contains and doesNotContain", () => {
		it("answer off the native firstIndex over either route", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect("Lions"::contains("ion"))
					Terminal.inspect("Lions"::contains("Tiger"))
					Terminal.inspect("Lions"::doesNotContain("Tiger"))
					Terminal.inspect("a${family}b"::contains("b"))
					Terminal.inspect("a${family}b"::contains("${family}"))
					Terminal.inspect("a${family}b"::doesNotContain("c"))
					Terminal.inspect(""::contains("a"))
				}`),
			).toEqual([
				"true",
				"false",
				"true",
				"true",
				"true",
				"true",
				"false",
			])
		})
	})

	// NOTE: The one rule for the empty part, stated once above `contains` in
	// `String.es` and answered by five entries: it matches nowhere, except as a
	// position at either end.
	describe("the empty part", () => {
		it("is a position at either end and an occurrence nowhere", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect("hello"::firstIndex(of "")::toString())
					Terminal.inspect("hello"::lastIndex(of "")::toString())
					Terminal.inspect("hello"::contains(""))
					Terminal.inspect("hello"::count(of ""))
					Terminal.inspect("hello"::replaceEvery("", with "-"))
					Terminal.inspect("hello"::replaceFirst("", with "-"))
					Terminal.inspect(""::firstIndex(of "")::toString())
					Terminal.inspect(""::lastIndex(of "")::toString())
					Terminal.inspect(""::replaceFirst("", with "-"))
				}`),
			).toEqual([
				'"Value(0)"',
				'"Value(5)"',
				"true",
				"0",
				'"hello"',
				'"hello"',
				'"Value(0)"',
				'"Value(0)"',
				'""',
			])
		})
	})

	describe("String.count(of:)", () => {
		it("counts the occurrences that do not overlap, by grapheme", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect("banana"::count(of "an"))
					Terminal.inspect("aaa"::count(of "aa"))
					Terminal.inspect("aaaa"::count(of "aa"))
					Terminal.inspect("banana"::count(of "zz"))
					Terminal.inspect("${family}a${family}"::count(of "${family}"))
					Terminal.inspect("a\\r\\nb\\r\\n"::count(of "\\r\\n"))
					Terminal.inspect("a\\r\\nb"::count(of "\\n"))
				}`),
			).toEqual(["2", "1", "2", "0", "2", "2", "0"])
		})
	})

	describe("String.replaceFirst(_:with:)", () => {
		it("cuts at the first occurrence and leaves the rest alone", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect("a-a-a"::replaceFirst("a", with "b"))
					Terminal.inspect("abcabc"::replaceFirst("bc", with "-"))
					Terminal.inspect("abc"::replaceFirst("c", with "xyz"))
					Terminal.inspect("abc"::replaceFirst("abc", with ""))
					Terminal.inspect("abc"::replaceFirst("abcd", with "z"))
					Terminal.inspect("abc"::replaceFirst("z", with "0"))
				}`),
			).toEqual(['"b-a-a"', '"a-abc"', '"abxyz"', '""', '"abc"', '"abc"'])
		})

		// NOTE: The two cuts are by grapheme, so a replacement beside a joined
		// emoji lands beside the whole of it, and a part that is one is cut
		// out whole.
		it("cuts by grapheme when a side is not ASCII", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect("a${family}b${family}"::replaceFirst("${family}", with "x"))
					Terminal.inspect("a${family}b"::replaceFirst("b", with "${family}"))
					Terminal.inspect("x\\r\\ny"::replaceFirst("y", with "z"))
					Terminal.inspect("x\\r\\ny"::replaceFirst("\\n", with "z"))
				}`),
			).toEqual([
				`"axb${family}"`,
				`"a${family}${family}"`,
				'"x\\r\\nz"',
				'"x\\r\\ny"',
			])
		})
	})
})
