import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { Lexer } from "@essence-lang/compiler/lexer"
import { escapeName } from "@essence-lang/compiler/rewriter/names"

import { demangleName, isCompilerBinding, isSingleWord } from "../names"

// Whether the Lexer reads all of `text` as one Identifier, Keyword or Boolean.
function lexesAsOneWord(text: string): boolean {
	let reader = new Lexer()

	reader.reset(text)

	let first = reader.next()

	if (
		first === undefined ||
		first.value !== text ||
		reader.next() !== undefined
	) {
		return false
	}

	let type: string = first.type

	return (
		type === "Identifier" ||
		type === "LiteralTrue" ||
		type === "LiteralFalse" ||
		type.startsWith("Keyword")
	)
}

describe("demangleName", () => {
	it("reads a standard library Method as Namespace.member", () => {
		expect(demangleName("$es_Boolean_isNot")).toBe("Boolean.isNot")
		expect(demangleName("$es_List_sorted")).toBe("List.sorted")
	})

	it("reads a Protocol's provided Method as Protocol.member", () => {
		expect(demangleName("$es_Sized__size")).toBe("Sized.size")
		expect(demangleName("$es_Tagged_2__describe")).toBe("Tagged.describe")
		expect(demangleName("$es_Tagged__shout__overload$1")).toBe(
			"Tagged.shout",
		)
	})

	it("strips the overload suffix first", () => {
		expect(demangleName("$es_Integer_divide__overload$1")).toBe(
			"Integer.divide",
		)
		expect(demangleName("replaceFirst__overload$2")).toBe("replaceFirst")
	})

	it("reverses the user mangling, hex escapes and all", () => {
		expect(demangleName("$user_ok_3f_")).toBe("ok?")
		expect(demangleName("$user_a_2b_b")).toBe("a+b")
		expect(demangleName("$user_List")).toBe("List")
	})

	it("uncovers a reserved word, and only a reserved word", () => {
		expect(demangleName("_new")).toBe("new")
		expect(demangleName("_default")).toBe("default")
		expect(demangleName("_self")).toBe("_self")
	})

	it("leaves an ordinary name alone", () => {
		expect(demangleName("greet")).toBe("greet")
		expect(demangleName("describe")).toBe("describe")
	})

	// The Rewriter mangles a name it uses itself, such as `$type` or
	// `Object`, and keeps a name JavaScript can spell, such as `café`.
	it("reads back every name the Rewriter escapes", () => {
		for (let name of [
			"ok?",
			"a+b",
			"new",
			"greet",
			"$type",
			"$context",
			"Object",
			"List",
			"café",
		]) {
			expect(demangleName(escapeName(name))).toBe(name)
		}
	})
})

describe("isSingleWord", () => {
	it("takes as one word what the Lexer reads as one word", () => {
		for (let text of [
			"greet",
			"ok?",
			"a+b",
			"new",
			"with",
			"true",
			"$type",
			"café",
			"x2",
			"initial.degrees",
			"f()",
			"x[0]",
			"a b",
			"2x",
			"12",
			"#Case",
			"name§",
			'"text"',
			"a_b",
			"",
		]) {
			expect([text, isSingleWord(text)]).toEqual([
				text,
				lexesAsOneWord(text),
			])
		}
	})
})

describe("isCompilerBinding", () => {
	it("knows the compiler's names from the author's", () => {
		expect(isCompilerBinding("$type")).toBe(true)
		expect(isCompilerBinding("$_")).toBe(true)
		expect(isCompilerBinding("$es_List_sorted")).toBe(true)
		expect(isCompilerBinding("Item__conformance")).toBe(true)
		expect(isCompilerBinding("greet")).toBe(false)
		expect(isCompilerBinding("_self")).toBe(false)
	})

	// A `require` subject's Constant is the only binding holding that value,
	// so the Variables view keeps it. The other names the Enricher mints go.
	it("keeps a require subject and leaves out the other names the Enricher mints", () => {
		expect(isCompilerBinding("$assertion_11_20")).toBe(false)

		for (let name of [
			"$pattern_6_12",
			"$parameter_4_18",
			"$row_14_4",
			"$any_3_9",
			"$candidate_3_9",
			"$source_3_9",
			"$drawn_3_9",
		]) {
			expect(isCompilerBinding(name)).toBe(true)
		}
	})
})

// The README says the adapter borrows only the compiler's naming rules, and
// names each one, so an import it adds must be named there too. An import of
// another shape could hide a name, so every import is held to the braced one.
describe("the compiler imports", () => {
	it("are each named in the README", () => {
		let sourceDirectory = join(import.meta.dir, "..")
		let readme = readFileSync(join(sourceDirectory, "../README.md"), "utf8")
		let sources = readdirSync(sourceDirectory)
			.filter((name) => name.endsWith(".ts"))
			.map((name) => readFileSync(join(sourceDirectory, name), "utf8"))
		let braced = sources.flatMap((source) => [
			...source.matchAll(
				/import (?:type )?\{([^}]*)\} from "@essence-lang\/compiler(?:\/[^"]+)?"/g,
			),
		])
		let imported = braced
			.flatMap((match) => (match[1] as string).split(","))
			.map((name) => name.trim().replace(/^type /, ""))
			.filter((name) => name !== "")

		expect(
			sources.flatMap((source) => [
				...source.matchAll(
					/from "@essence-lang\/compiler(?:\/[^"]+)?"/g,
				),
			]).length,
		).toBe(braced.length)
		expect(imported.length).toBeGreaterThan(0)
		expect(
			imported.filter((name) => !readme.includes(`\`${name}\``)),
		).toEqual([])
	})
})
