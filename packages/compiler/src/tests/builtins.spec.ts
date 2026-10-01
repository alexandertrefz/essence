import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"
import * as algebraic from "@essence-lang/runtime/Algebraic"
import * as async from "@essence-lang/runtime/Async"
import * as boolean from "@essence-lang/runtime/Boolean"
import * as caseSensitivity from "@essence-lang/runtime/CaseSensitivity"
import * as dictionary from "@essence-lang/runtime/Dictionary"
import * as division from "@essence-lang/runtime/Division"
import * as functions from "@essence-lang/runtime/functions"
import * as future from "@essence-lang/runtime/Future"
import * as futureList from "@essence-lang/runtime/FutureList"
import * as groupedList from "@essence-lang/runtime/GroupedList"
import * as groupedNonEmptyList from "@essence-lang/runtime/GroupedNonEmptyList"
import * as http from "@essence-lang/runtime/Http"
import * as httpFailure from "@essence-lang/runtime/HttpFailure"
import * as httpMethod from "@essence-lang/runtime/HttpMethod"
import * as integer from "@essence-lang/runtime/Integer"
import * as integerList from "@essence-lang/runtime/IntegerList"
import * as keyedNumberList from "@essence-lang/runtime/KeyedNumberList"
import * as list from "@essence-lang/runtime/List"
import * as nestedList from "@essence-lang/runtime/NestedList"
import * as nestedOptional from "@essence-lang/runtime/NestedOptional"
import * as nestedResult from "@essence-lang/runtime/NestedResult"
import * as nonEmptyDictionary from "@essence-lang/runtime/NonEmptyDictionary"
import * as nonEmptyFutureList from "@essence-lang/runtime/NonEmptyFutureList"
import * as nonEmptyIntegerList from "@essence-lang/runtime/NonEmptyIntegerList"
import * as nonEmptyKeyedNumberList from "@essence-lang/runtime/NonEmptyKeyedNumberList"
import * as nonEmpty from "@essence-lang/runtime/NonEmptyList"
import * as nonEmptyNestedList from "@essence-lang/runtime/NonEmptyNestedList"
import * as nonEmptyNumberList from "@essence-lang/runtime/NonEmptyNumberList"
import * as nonEmptyRationalList from "@essence-lang/runtime/NonEmptyRationalList"
import * as nonEmptyString from "@essence-lang/runtime/NonEmptyString"
import * as nonNegativeInteger from "@essence-lang/runtime/NonNegativeInteger"
import * as nonNegativeRational from "@essence-lang/runtime/NonNegativeRational"
import * as nonZeroInteger from "@essence-lang/runtime/NonZeroInteger"
import * as nonZeroRational from "@essence-lang/runtime/NonZeroRational"
import * as normalizationForm from "@essence-lang/runtime/NormalizationForm"
import * as number from "@essence-lang/runtime/Number"
import * as numberFormat from "@essence-lang/runtime/NumberFormat"
import * as numberList from "@essence-lang/runtime/NumberList"
import * as optional from "@essence-lang/runtime/Optional"
import * as optionalList from "@essence-lang/runtime/OptionalList"
import * as ordering from "@essence-lang/runtime/Ordering"
import * as positiveInteger from "@essence-lang/runtime/PositiveInteger"
import * as positiveRational from "@essence-lang/runtime/PositiveRational"
import * as randomness from "@essence-lang/runtime/Randomness"
import * as rational from "@essence-lang/runtime/Rational"
import * as rationalList from "@essence-lang/runtime/RationalList"
import * as record from "@essence-lang/runtime/Record"
import * as redirects from "@essence-lang/runtime/Redirects"
import * as response from "@essence-lang/runtime/Response"
import * as result from "@essence-lang/runtime/Result"
import * as resultFuture from "@essence-lang/runtime/ResultFuture"
import * as resultFutureList from "@essence-lang/runtime/ResultFutureList"
import * as resultList from "@essence-lang/runtime/ResultList"
import * as rounding from "@essence-lang/runtime/Rounding"
import * as scalar from "@essence-lang/runtime/Scalar"
import * as side from "@essence-lang/runtime/Side"
import * as signStyle from "@essence-lang/runtime/SignStyle"
import * as sortOrder from "@essence-lang/runtime/SortOrder"
import * as started from "@essence-lang/runtime/Started"
import * as stream from "@essence-lang/runtime/Stream"
import * as string from "@essence-lang/runtime/String"
import * as terminal from "@essence-lang/runtime/Terminal"
import * as transcendental from "@essence-lang/runtime/Transcendental"

import { builtinMemberOrder, builtinNamespaces } from "../enricher/builtins"
import { loadStdlib } from "../enricher/stdlib"
import { resolveOverloadedMethodName } from "../helpers/types"
import { runtimeNamespaceNames } from "../rewriter/index"
import { nativeArity } from "../tools/generateNatives"

// The Rewriter imports one runtime module per builtin Namespace under the
// Namespace's own name. A spec holds these keys to `runtimeNamespaceNames`.
const runtimeModules: Record<string, Record<string, unknown>> = {
	Terminal: terminal,
	String: string,
	NonEmptyString: nonEmptyString,
	Boolean: boolean,
	Integer: integer,
	NonZeroInteger: nonZeroInteger,
	NonNegativeInteger: nonNegativeInteger,
	PositiveInteger: positiveInteger,
	Rational: rational,
	NonZeroRational: nonZeroRational,
	NonNegativeRational: nonNegativeRational,
	PositiveRational: positiveRational,
	// No natives: the module holds only the type a native taking a Scalar
	// spells. The row is here because the Rewriter imports it.
	Scalar: scalar,
	Algebraic: algebraic,
	Transcendental: transcendental,
	Number: number,
	Optional: optional,
	NestedOptional: nestedOptional,
	Result: result,
	// No natives: `flatten` is written in Essence, as `NestedOptional`'s is.
	NestedResult: nestedResult,
	Ordering: ordering,
	Side: side,
	CaseSensitivity: caseSensitivity,
	NormalizationForm: normalizationForm,
	NumberFormat: numberFormat,
	Rounding: rounding,
	SignStyle: signStyle,
	Division: division,
	SortOrder: sortOrder,
	// No natives: every Method is derived from the Choice.
	Stream: stream,
	Record: record,
	List: list,
	NestedList: nestedList,
	OptionalList: optionalList,
	ResultList: resultList,
	NonEmptyList: nonEmpty,
	NonEmptyNestedList: nonEmptyNestedList,
	IntegerList: integerList,
	RationalList: rationalList,
	NumberList: numberList,
	NonEmptyIntegerList: nonEmptyIntegerList,
	NonEmptyRationalList: nonEmptyRationalList,
	NonEmptyNumberList: nonEmptyNumberList,
	KeyedNumberList: keyedNumberList,
	NonEmptyKeyedNumberList: nonEmptyKeyedNumberList,
	Dictionary: dictionary,
	NonEmptyDictionary: nonEmptyDictionary,
	GroupedList: groupedList,
	GroupedNonEmptyList: groupedNonEmptyList,
	Randomness: randomness,
	// Both the Namespace's module and the asynchrony machinery that emitted
	// code reads as `$future`. The Namespaces for Lists of Futures re-export
	// their natives from it.
	Future: future,
	ResultFuture: resultFuture,
	FutureList: futureList,
	NonEmptyFutureList: nonEmptyFutureList,
	ResultFutureList: resultFutureList,
	// The Methods of a started run, as opposed to the work it describes.
	Started: started,
	Async: async,
	// Reaches another host. `cli/src/resultCache.ts` refuses to cache a run
	// whose bundle carries esbuild's label for this file, so its name matters.
	Http: http,
	// No natives: its Methods are written in Essence.
	Response: response,
	// No natives: every Method is derived from the Choice.
	HttpMethod: httpMethod,
	Redirects: redirects,
	// Its Cases print in their own words, so `toString` is written rather
	// than derived.
	HttpFailure: httpFailure,
}

// The names the Simplifier emits for a declared Method: the bare name, or
// `name__overload$N` by written index, as `nativeBindings` is indexed. The
// arity comes from the generator's own `nativeArity`, so both checks agree.
function expectedExports(
	name: string,
	method: common.MethodType,
): Array<{ name: string; arity: number }> {
	if (
		method.type === "OverloadedMethod" ||
		method.type === "OverloadedStaticMethod"
	) {
		return method.overloads.map((overload, index) => ({
			name: resolveOverloadedMethodName(name, index),
			arity: nativeArity(overload),
		}))
	}

	return [{ name, arity: nativeArity(method) }]
}

// Which entries of a Namespace member are native. A member the loader
// recorded no binding for had no body, so it defaults to native.
function nativeFlagsFor(
	namespaceName: string,
	memberName: string,
	count: number,
): Array<boolean> {
	let bindings = loadStdlib().nativeBindings[namespaceName]

	if (bindings === undefined) {
		return Array.from({ length: count }, () => true)
	}

	return (
		bindings.methods[memberName] ??
		Array.from({ length: count }, () => true)
	)
}

describe("Builtins", () => {
	// tsc holds `natives.generated.ts` against each runtime module per
	// signature. This check groups by Namespace and covers one with no module.
	// A Namespace declared but not imported, or the reverse, calls `undefined`.
	it("registers every builtin Namespace at every site", () => {
		let declared = builtinNamespaces()
			.map((namespace) => namespace.name)
			.sort()
		let imported = [...runtimeNamespaceNames].sort()
		let tabled = Object.keys(runtimeModules).sort()

		expect(imported).toEqual(declared)
		// This spec's own module table agrees with the Rewriter's list.
		expect(tabled).toEqual(imported)
	})

	// The comment on `Dictionary` in `builtinMemberOrder` lists the Method
	// names it shares with the Namespaces before it. A list in a comment goes
	// stale silently, so this holds it to the declarations.
	it("shares exactly the Method names its NOTE names", () => {
		let namespaces = new Map(
			loadStdlib().namespaces.map((namespace) => [
				namespace.name,
				namespace,
			]),
		)
		let dictionary = namespaces.get("Dictionary")

		expect(dictionary).toBeDefined()

		let mine = new Set(Object.keys(dictionary!.methods))
		let shared = new Set<string>()

		for (let name of builtinMemberOrder.slice(
			0,
			builtinMemberOrder.indexOf("Dictionary"),
		)) {
			for (let member of Object.keys(
				namespaces.get(name)?.methods ?? {},
			)) {
				if (mine.has(member)) {
					shared.add(member)
				}
			}
		}

		expect([...shared].sort()).toEqual([
			"count",
			"hasValue",
			"is",
			"isEmpty",
			"keys",
			"length",
			"map",
			"of",
			"remove",
			"removeEvery",
			"sort",
			"toString",
			"value",
			"values",
		])
	})

	// A native with no export under the name the Simplifier asks for passes
	// `essence check` and calls `undefined` at run time. An Essence-bodied
	// Method with an export is dead code. Each export's `.length` must also match
	// the declared arity.
	describe("every declared Method has a runtime implementation", () => {
		for (let namespace of builtinNamespaces()) {
			it(`implements ${namespace.name}`, () => {
				let missing: Array<string> = []
				let stale: Array<string> = []
				let wrongArity: Array<string> = []
				let runtime = runtimeModules[namespace.name] ?? {}

				for (let [name, method] of Object.entries(namespace.methods)) {
					let exports = expectedExports(name, method)
					let native = nativeFlagsFor(
						namespace.name,
						name,
						exports.length,
					)

					exports.forEach(({ name: exportName, arity }, index) => {
						let implementation = runtime[exportName]

						if (native[index] ?? true) {
							if (typeof implementation === "function") {
								// A default or rest Parameter makes
								// `Parameters<T>['length']` non-literal, which
								// tsc cannot check, so the function is asked.
								if (implementation.length !== arity) {
									wrongArity.push(
										`${namespace.name}.${exportName} takes ${implementation.length}, declares ${arity}`,
									)
								}
							} else {
								missing.push(`${namespace.name}.${exportName}`)
							}
						} else if (typeof implementation === "function") {
							stale.push(`${namespace.name}.${exportName}`)
						}
					})
				}

				let propertyBindings =
					loadStdlib().nativeBindings[namespace.name]?.properties

				for (let name of Object.keys(namespace.properties)) {
					let native = propertyBindings?.[name] ?? true

					if (native) {
						if (runtime[name] === undefined) {
							missing.push(`${namespace.name}.${name}`)
						}
					} else if (runtime[name] !== undefined) {
						stale.push(`${namespace.name}.${name}`)
					}
				}

				// Only a Namespace that binds a native needs a runtime module.
				if (missing.length > 0) {
					expect(runtimeModules[namespace.name]).toBeDefined()
				}

				expect(missing).toEqual([])
				expect(stale).toEqual([])
				expect(wrongArity).toEqual([])
			})
		}
	})

	// A free Function such as `loop` keeps a Method's promises. A native one
	// has a runtime export under its emitted name, and every one is documented.
	describe("free Functions", () => {
		// The emitted names of the native entries, which the Rewriter reads off
		// the `functions` module.
		function nativeExportNames(): Array<string> {
			let stdlib = loadStdlib()
			let names: Array<string> = []

			for (let [name, flags] of Object.entries(stdlib.functionBindings)) {
				let member = stdlib.members[name]

				if (member?.type === "OverloadedStaticMethod") {
					flags.forEach((native, index) => {
						if (native) {
							names.push(resolveOverloadedMethodName(name, index))
						}
					})
				} else if (flags[0]) {
					names.push(name)
				}
			}

			return names
		}

		it("binds every native free Function to a runtime export", () => {
			let runtime = functions as Record<string, unknown>
			let missing = nativeExportNames().filter(
				(name) => typeof runtime[name] !== "function",
			)

			expect(missing).toEqual([])
		})

		it("documents every declared free Function", () => {
			let stdlib = loadStdlib()
			let undocumented: Array<string> = []

			for (let name of Object.keys(stdlib.functionBindings)) {
				let member = stdlib.members[name]
				let documentation =
					member?.type === "Function" ||
					member?.type === "OverloadedStaticMethod"
						? member.documentation
						: undefined

				if (
					documentation === undefined ||
					documentation === null ||
					typeof documentation.description !== "string" ||
					documentation.description.length === 0
				) {
					undocumented.push(name)
				}
			}

			expect(undocumented).toEqual([])
		})

		// `loop` mixes native and Essence-bodied entries, and each flag's
		// position is the `__overload$N` index the Rewriter binds by.
		it("declares loop as a partly native overloaded free Function", () => {
			let stdlib = loadStdlib()

			expect(Object.keys(stdlib.functionBindings)).toEqual(["loop"])
			expect(stdlib.functionBindings["loop"]).toEqual([
				true,
				false,
				false,
				true,
				false,
				false,
				false,
				false,
				false,
			])
			expect(stdlib.members["loop"]?.type).toBe("OverloadedStaticMethod")
			expect(typeof functions.loop__overload$1).toBe("function")
			expect(typeof functions.loop__overload$4).toBe("function")
		})
	})

	// `Terminal`'s natives exist for their effect, and their answers do not
	// show whether they ran. So the bindings are pinned exactly.
	describe("Terminal", () => {
		it("binds exactly the native entries to the runtime", () => {
			let bindings = loadStdlib().nativeBindings["Terminal"]

			// `print` and `ask` are Essence. The Stream is a default rather than
			// an Overload, so each Method has one flag and a plain export name.
			expect(bindings?.methods).toEqual({
				print: [false],
				write: [true],
				inspect: [true],
				describe: [true],
				readLine: [true],
				readAll: [true],
				ask: [false],
			})

			let runtime = terminal as Record<string, unknown>

			expect(typeof runtime["write"]).toBe("function")
			expect(typeof runtime["inspect"]).toBe("function")
			expect(typeof runtime["describe"]).toBe("function")
			expect(typeof runtime["readLine"]).toBe("function")
			expect(typeof runtime["readAll"]).toBe("function")
			expect(runtime["print"]).toBeUndefined()
			expect(runtime["ask"]).toBeUndefined()
			expect(runtime["write__overload$1"]).toBeUndefined()
			expect(runtime["write__overload$2"]).toBeUndefined()
		})
	})

	// Hover and Signature Help show these descriptions, so an undocumented
	// Method would show a blank tooltip.
	describe("every declared Method carries documentation", () => {
		for (let namespace of builtinNamespaces()) {
			it(`documents ${namespace.name}`, () => {
				let undocumented: Array<string> = []

				for (let [name, method] of Object.entries(namespace.methods)) {
					let documentation = method.documentation

					if (
						documentation === undefined ||
						documentation === null ||
						typeof documentation.description !== "string" ||
						documentation.description.length === 0
					) {
						undocumented.push(`${namespace.name}::${name}`)
					}
				}

				expect(undocumented).toEqual([])
			})
		}
	})
})
