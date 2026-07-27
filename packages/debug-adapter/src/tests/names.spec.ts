import { describe, expect, it } from "bun:test"

import {
	demangleName,
	escapeNameForEvaluation,
	isCompilerBinding,
} from "../names"

describe("demangleName", () => {
	it("reads a standard library Method as Namespace.member", () => {
		expect(demangleName("$es_Boolean_isNot")).toBe("Boolean.isNot")
		expect(demangleName("$es_List_sorted")).toBe("List.sorted")
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
})

describe("escapeNameForEvaluation", () => {
	it("round-trips with the demangler", () => {
		for (let name of ["ok?", "a+b", "new", "greet"]) {
			expect(demangleName(escapeNameForEvaluation(name))).toBe(name)
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
