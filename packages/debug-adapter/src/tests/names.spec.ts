import { describe, expect, it } from "bun:test"

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
})
