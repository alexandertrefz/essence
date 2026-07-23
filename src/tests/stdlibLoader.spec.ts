import { describe, expect, it } from "bun:test"

import { builtinMemberOrder, builtinTypeOrder } from "../enricher/builtins"
import {
	loadStdlib,
	loadStdlibFrom,
	parseStdlibSource,
	type Stdlib,
} from "../enricher/stdlib"
import type { common } from "../interfaces/index"
import { simplify } from "../simplifier/index"

function load(...files: Array<[string, string]>): Stdlib {
	return loadStdlibFrom(
		files.map(([fileName, source]) => parseStdlibSource(fileName, source)),
	)
}

function namespaceNamed(stdlib: Stdlib, name: string): common.NamespaceType {
	let namespace = stdlib.members[name]

	if (namespace === undefined || namespace.type !== "Namespace") {
		throw new Error(`'${name}' did not load as a Namespace`)
	}

	return namespace
}

function namespaceNodeIn(
	program: common.typed.Program,
	name: string,
): common.typed.NamespaceDefinitionStatementNode {
	for (let node of program.implementation.nodes) {
		if (
			node.nodeType === "NamespaceDefinitionStatement" &&
			node.name.content === name
		) {
			return node
		}
	}

	throw new Error(`no typed Namespace '${name}' in the Program`)
}

// NOTE: The emitted Method names for one Namespace of a synthetic standard
// library, which is where the `__overload$N` numbering becomes observable.
function emittedMethodNames(stdlib: Stdlib, name: string): Array<string> {
	let simplified = simplify(stdlib.typedPrograms[0]!)

	for (let node of simplified.implementation.nodes) {
		if (
			node.nodeType === "NamespaceDefinitionStatement" &&
			node.name.name === name
		) {
			return Object.keys(node.methods)
		}
	}

	throw new Error(`no simplified Namespace '${name}' in the Program`)
}

// NOTE: The three Overload spellings the numbering has to survive — one bound
// to the runtime, two written in Essence with signatures that can be told
// apart.
const overloadEntries = {
	native: "\t\t\t\t\t\t(_ other: Integer) -> Integer",
	bodiedString:
		"\t\t\t\t\t\t(_ other: String) -> String {\n\t\t\t\t\t\t\t<- other\n\t\t\t\t\t\t}",
	bodiedBoolean:
		"\t\t\t\t\t\t(_ other: Boolean) -> Boolean {\n\t\t\t\t\t\t\t<- other\n\t\t\t\t\t\t}",
}

function overloadNamespace(
	entries: Array<keyof typeof overloadEntries>,
): Stdlib {
	return load([
		"Overloads.es",
		`declarations {
	namespace Mixed for Integer {
		§§ Combines two values.
		overload combine {
${entries.map((entry) => overloadEntries[entry]).join("\n")}
		}
	}
}`,
	])
}

describe("Standard Library Loader", () => {
	// NOTE: The whole point of the `declarations { … }` form — a signature with
	// no body IS the declaration. Every shape the Enricher needs of a builtin
	// Namespace has to come out of a signature alone: the Method Types, the
	// Type Parameters, the Documentation, and the record of which entries are
	// bound to the runtime.
	it("resolves a native Namespace into a complete Namespace Type", () => {
		let stdlib = load(
			[
				"Boxes.es",
				`declarations {
				namespace Boxes <ItemType> for List<ItemType> {
					§§ The first item, if there is one.
					§§ @returns the first item.
					firstItem() -> Optional<ItemType>

					§§ Wraps a value.
					static wrap <Item>(_ value: Item) -> List<Item>

					§§ How many items the empty Box holds.
					static emptyCount: Integer
				}
			}`,
			],
			// NOTE: `Optional` is declared in Essence now, so a synthetic
			// library that uses it has to bring its own — which is the point:
			// the file that USES a name is hoisted alongside the file that
			// DECLARES it, in either order.
			[
				"Fallible.es",
				`declarations {
				type Optional<ItemType> = ItemType | Nothing
			}`,
			],
		)

		let namespace = namespaceNamed(stdlib, "Boxes")

		expect(namespace.name).toBe("Boxes")
		expect(namespace.generics.map((generic) => generic.name)).toEqual([
			"ItemType",
		])
		expect(namespace.targetType).toEqual({
			type: "List",
			itemType: { type: "GenericUse", name: "ItemType" },
		})

		let firstItem = namespace.methods["firstItem"]!

		expect(firstItem.type).toBe("SimpleMethod")

		if (firstItem.type === "SimpleMethod") {
			// NOTE: The receiver Parameter is injected, exactly as for a bodied
			// Method, and the Namespace Generic the signature mentions is
			// merged in.
			expect(firstItem.parameterTypes).toHaveLength(1)
			expect(firstItem.generics.map((generic) => generic.name)).toEqual([
				"ItemType",
			])
			expect(firstItem.documentation?.description).toBe(
				"The first item, if there is one.",
			)
			// NOTE: A builtin has no file to point at.
			expect(firstItem.documentation?.position).toBeNull()
		}

		let wrap = namespace.methods["wrap"]!

		expect(wrap.type).toBe("StaticMethod")

		if (wrap.type === "StaticMethod") {
			expect(wrap.parameterTypes).toHaveLength(1)
			expect(wrap.generics.map((generic) => generic.name)).toEqual([
				"Item",
			])
		}

		expect(namespace.properties["emptyCount"]).toEqual({ type: "Integer" })

		expect(stdlib.nativeBindings["Boxes"]).toEqual({
			methods: { firstItem: [true], wrap: [true] },
			properties: { emptyCount: true },
		})

		// NOTE: A native has no body, so there is nothing for the Rewriter to
		// emit — the Namespace is in the Type tables and absent from the tree.
		let typed = namespaceNodeIn(stdlib.typedPrograms[0]!, "Boxes")

		expect(Object.keys(typed.methods)).toEqual([])
		expect(Object.keys(typed.properties)).toEqual([])
	})

	// NOTE: An `overload` block may mix the two — one Overload bound to the
	// runtime, the next written in Essence. Order is load-bearing: the index
	// picks the `__overload$N` export name, so a native must still occupy its
	// slot in the resolved Type even though nothing is emitted for it.
	it("keeps a mixed overload block in written order", () => {
		let stdlib = load([
			"Mixed.es",
			`declarations {
				namespace Mixed for Integer {
					§§ Combines two values.
					overload combine {
						(_ other: Integer) -> Integer
						(_ other: String) -> String {
							<- other
						}
					}
				}
			}`,
		])

		let combine = namespaceNamed(stdlib, "Mixed").methods["combine"]!

		expect(combine.type).toBe("OverloadedMethod")

		if (combine.type === "OverloadedMethod") {
			expect(combine.overloads).toHaveLength(2)
			expect(combine.overloads[0]!.returnType).toEqual({
				type: "Integer",
			})
			expect(combine.overloads[1]!.returnType).toEqual({ type: "String" })
		}

		expect(stdlib.nativeBindings["Mixed"]!.methods["combine"]).toEqual([
			true,
			false,
		])

		// NOTE: Only the bodied Overload reaches the typed tree.
		let typed = namespaceNodeIn(stdlib.typedPrograms[0]!, "Mixed")
		let typedCombine = typed.methods["combine"]!

		expect(typedCombine.nodeType).toBe("OverloadedMethod")

		if (typedCombine.nodeType === "OverloadedMethod") {
			expect(typedCombine.methods).toHaveLength(1)
			expect(typedCombine.methods[0]!.type.returnType).toEqual({
				type: "String",
			})
		}
	})

	// NOTE: The `__overload$N` suffix is the Overload's position in the Method
	// TYPE, not in the filtered typed Node — a call site resolves its index
	// against the full Type, and the slot a native occupies is already taken by
	// the runtime export it binds to. Emitting a bodied Overload under a
	// filtered index would both answer to a name nobody calls and CLOBBER that
	// export.
	describe("numbers emitted Overloads by their position in the Method Type", () => {
		it("skips the slot a leading native occupies", () => {
			let stdlib = overloadNamespace(["native", "bodiedString"])

			expect(stdlib.nativeBindings["Mixed"]!.methods["combine"]).toEqual([
				true,
				false,
			])
			expect(emittedMethodNames(stdlib, "Mixed")).toEqual([
				"combine__overload$2",
			])
		})

		it("skips the slot a native between two bodied Overloads occupies", () => {
			let stdlib = overloadNamespace([
				"bodiedString",
				"native",
				"bodiedBoolean",
			])

			expect(stdlib.nativeBindings["Mixed"]!.methods["combine"]).toEqual([
				false,
				true,
				false,
			])
			expect(emittedMethodNames(stdlib, "Mixed")).toEqual([
				"combine__overload$1",
				"combine__overload$3",
			])
		})

		it("skips the slots two leading natives occupy", () => {
			let stdlib = overloadNamespace([
				"native",
				"bodiedString",
				"bodiedBoolean",
			])

			expect(emittedMethodNames(stdlib, "Mixed")).toEqual([
				"combine__overload$2",
				"combine__overload$3",
			])
		})

		// NOTE: The failure this numbering exists to prevent. A native's
		// runtime export answers to the name its slot gives it; a bodied
		// definition emitted under the same name would silently replace the
		// implementation of a DIFFERENT Overload.
		it("never emits a definition under a native's export name", () => {
			for (let entries of [
				["native", "bodiedString"],
				["bodiedString", "native", "bodiedBoolean"],
				["native", "native", "bodiedString"],
			] as const) {
				let stdlib = overloadNamespace([...entries])
				let flags = stdlib.nativeBindings["Mixed"]!.methods["combine"]!
				let emitted = new Set(emittedMethodNames(stdlib, "Mixed"))

				flags.forEach((native, index) => {
					if (native) {
						expect(
							emitted.has(`combine__overload$${index + 1}`),
						).toBe(false)
					}
				})

				expect(emitted.size).toBe(
					flags.filter((native) => !native).length,
				)
			}
		})

		// NOTE: The other half of the invariant. Where nothing is native the
		// indices are the identity, and an ordinary Program relies on it —
		// every `overload` block a user writes takes this path, and a
		// mis-numbered one emits definitions no call site names.
		it("numbers an all bodied block from one, in order", () => {
			let stdlib = overloadNamespace(["bodiedString", "bodiedBoolean"])

			expect(stdlib.nativeBindings["Mixed"]!.methods["combine"]).toEqual([
				false,
				false,
			])
			expect(emittedMethodNames(stdlib, "Mixed")).toEqual([
				"combine__overload$1",
				"combine__overload$2",
			])
		})
	})

	it("resolves a native static Property from its annotation", () => {
		let stdlib = load([
			"Constants.es",
			`declarations {
				namespace Constants {
					static PI: Transcendental
				}
			}`,
		])

		expect(namespaceNamed(stdlib, "Constants").properties["PI"]).toEqual({
			type: "Transcendental",
		})
		expect(stdlib.nativeBindings["Constants"]!.properties["PI"]).toBe(true)
	})

	// NOTE: The standard library is ONE declaration space, not a chain of
	// imports — every file is hoisted before any is enriched, so nothing has to
	// be declared before it is used, in any file.
	it("resolves a reference across two files", () => {
		let stdlib = load(
			[
				"Namespaces.es",
				`declarations {
					namespace Sized for String is Measurable {
						size() -> Integer
					}
				}`,
			],
			[
				"Protocols.es",
				`declarations {
					§§ Anything with a size.
					protocol Measurable {
						size() -> Integer
					}
				}`,
			],
		)

		expect(stdlib.protocols["Measurable"]?.name).toBe("Measurable")
		expect(namespaceNamed(stdlib, "Sized").conformsTo).toEqual([
			"Measurable",
		])
	})

	// NOTE: A Method with a body survives into the typed tree — that is what
	// the prelude the Rewriter emits is built out of.
	it("keeps a bodied Method's typed Node", () => {
		let stdlib = load([
			"Bodied.es",
			// NOTE: The bodied Method calls a NATIVE sibling declared in the
			// same synthetic file rather than a builtin like
			// `Integer::multiply`. A synthetic standard library is
			// enriched against the bare Type tags plus these sources ALONE —
			// nothing of `src/stdlib` is in scope — so reaching for a real
			// builtin Method would simply not resolve.
			`declarations {
				namespace Doubler for Integer {
					§§ Twice the value.
					double() -> Integer {
						<- @::twice()
					}

					§§ Twice the value, natively.
					twice() -> Integer
				}
			}`,
		])

		expect(namespaceNamed(stdlib, "Doubler").methods["double"]?.type).toBe(
			"SimpleMethod",
		)
		expect(stdlib.nativeBindings["Doubler"]!.methods["double"]).toEqual([
			false,
		])

		let typed = namespaceNodeIn(stdlib.typedPrograms[0]!, "Doubler")
		let double = typed.methods["double"]!

		expect(double.nodeType).toBe("SimpleMethod")

		if (double.nodeType === "SimpleMethod") {
			expect(double.method.value.body).not.toHaveLength(0)
		}
	})

	// NOTE: A native Method has only TWO of the three views the retention
	// invariant is about — the resolved Method Type and the witnesses
	// `boundConformance` curries on. There is no typed Node, because there is
	// no body to emit. The Type view must still carry the bound Namespace
	// Generic, or the hidden conformance Parameter its call sites pass would
	// have nothing to bind to.
	it("retains a bound Namespace Generic on a native fulfilling Method", () => {
		let stdlib = load(
			[
				"Boxes.es",
				`declarations {
				namespace Boxes <infer Item> for { value: Item }
					is Comparable where Item is Comparable
				{
					§§ Orders two Boxes by their values.
					compareTo(_ other: { value: Item }) -> Ordering
				}
			}`,
			],
			// NOTE: `Comparable` and `Ordering` are declared in Essence now.
			// The conforming file is hoisted BEFORE the one that declares the
			// Protocol it conforms to, in sorted order — which is exactly what
			// the shared Scope is for.
			[
				"Ordered.es",
				`declarations {
				choice Ordering { Less, Equal, Greater }

				protocol Comparable {
					compareTo(_ other: Self) -> Ordering
				}
			}`,
			],
		)

		let namespace = namespaceNamed(stdlib, "Boxes")
		let compareTo = namespace.methods["compareTo"]!

		expect(compareTo.type).toBe("SimpleMethod")

		if (compareTo.type === "SimpleMethod") {
			expect(compareTo.generics).toEqual([
				{
					name: "Item",
					defaultType: null,
					infer: true,
					constraint: "Comparable",
				},
			])
		}

		expect(namespace.conformanceConditions).toEqual({
			Comparable: [{ generic: "Item", protocol: "Comparable" }],
		})

		// NOTE: The third view is simply absent — nothing to keep in step.
		let typed = namespaceNodeIn(stdlib.typedPrograms[0]!, "Boxes")

		expect(Object.keys(typed.methods)).toEqual([])
	})

	// NOTE: A Diagnostic in the standard library is a Compiler developer's
	// error — there is no user Program in sight, and every stage downstream
	// would run against a half-built Scope. It is thrown, rendered exactly as
	// the CLI would print it.
	it("throws the rendered Diagnostic when a declaration does not enrich", () => {
		let load = () =>
			loadStdlibFrom([
				parseStdlibSource(
					"Broken.es",
					`declarations {
						namespace Broken for Nonexistent {
							size() -> Integer
						}
					}`,
				),
			])

		expect(load).toThrow(/Nonexistent/)
		expect(load).toThrow(/Broken\.es/)
		expect(load).toThrow(/standard library failed to enrich/)
	})

	// NOTE: The files share one declaration Scope, so a mistake in the file that
	// DECLARES something surfaces as a Diagnostic in every file that USES it.
	// Reporting only the first failure in sorted order reliably shows the
	// cascade and hides the cause.
	it("reports every failing file, not just the first", () => {
		let load = () =>
			loadStdlibFrom([
				parseStdlibSource(
					"A.es",
					`declarations {
						namespace Sized for String is Measurable {
							size() -> Integer
						}
					}`,
				),
				parseStdlibSource(
					"B.es",
					`declarations {
						protocol Measurable {
							size() -> Nonexistent
						}
					}`,
				),
			])

		expect(load).toThrow(/A\.es/)
		expect(load).toThrow(/B\.es/)
		expect(load).toThrow(/Nonexistent/)
	})

	// NOTE: A native Property IS its annotation, so without one there is
	// nothing to declare. Resolving it to Error in silence would let the
	// zero-Diagnostic gate wave through a Property of no Type at all.
	it("rejects a static Property with neither a value nor a Type", () => {
		let load = () =>
			loadStdlibFrom([
				parseStdlibSource(
					"Constants.es",
					`declarations {
						namespace Constants {
							static PI
						}
					}`,
				),
			])

		expect(load).toThrow(/native-property-without-type/)
		expect(load).toThrow(/PI/)
	})

	// NOTE: Every Documentation a consumer can reach has to be sourceless — a
	// Position pointing into a standard library file is a Position with no file
	// attached, as far as every consumer of these tables is concerned.
	it("strips the Documentation Position off a top level Function too", () => {
		let stdlib = load([
			"Functions.es",
			`declarations {
				§§ Answers with the value it was given.
				function identity <Item>(_ value: Item) -> Item {
					<- value
				}
			}`,
		])

		let identity = stdlib.members["identity"]!

		expect(identity.type).toBe("Function")

		if (identity.type === "Function") {
			expect(identity.documentation?.description).toBe(
				"Answers with the value it was given.",
			)
			expect(identity.documentation?.position).toBeNull()
		}
	})

	it("throws the rendered Diagnostic when a file does not parse", () => {
		expect(() =>
			loadStdlibFrom([
				parseStdlibSource(
					"Unparseable.es",
					`declarations {
						namespace Unclosed for Integer {
					}`,
				),
			]),
		).toThrow(/standard library failed to parse/)
	})

	// NOTE: An `implementation { … }` file can not declare a native at all, so
	// accepting one would silently produce a Namespace missing exactly the
	// Methods the file was written to add.
	it("rejects an implementation Program", () => {
		expect(() =>
			load([
				"Implementation.es",
				`implementation {
					namespace Doubler for Integer {
						double() -> Integer {
							<- @::multiply(with 2)
						}
					}
				}`,
			]),
		).toThrow(/must open with 'declarations/)
	})

	// NOTE: Enriched once per process — every consumer reads the same object,
	// so the library is parsed, hoisted and validated exactly once no matter
	// how many files are compiled.
	// NOTE: The member table is listed in ONE canonical order, stated in
	// `builtinMemberOrder`, not in the order the files happened to sort in. A
	// source declaration is enriched INTO the Scope and lands where insertion
	// put it, so renaming `List.es` would otherwise reorder the Completion list
	// and the Enricher's Namespace search.
	it("lists the builtin Namespaces in one order, whatever the file names", () => {
		expect(
			loadStdlib().namespaces.map((namespace) => namespace.name),
		).toEqual([
			"String",
			"Boolean",
			"Integer",
			"Rational",
			"Algebraic",
			"Transcendental",
			"Number",
			"Nothing",
			"Optional",
			"Ordering",
			"Record",
			"List",
			// NOTE: The one Namespace a List value can reach besides `List`,
			// listed after it — see `builtinMemberOrder`. `List` has to be
			// searched FIRST for a `List<List<…>>` receiver, so that the
			// narrow Namespace reads as the extra it is.
			"NestedList",
		])
	})

	// NOTE: The other half of the ordering rule. `builtinMemberOrder` is the
	// SOLE source of order — there is no second table whose key order could
	// stand in for it. A name listed that no longer exists is dead weight that
	// reads as intent; a member that exists but is unlisted is appended LAST,
	// which is exactly the silent reordering the list is here to prevent.
	it("orders every builtin member by name, and names only members that exist", () => {
		let members = Object.keys(loadStdlib().members)

		expect(
			members.filter((name) => !builtinMemberOrder.includes(name)),
		).toEqual([])
		expect(
			builtinMemberOrder.filter((name) => !members.includes(name)),
		).toEqual([])
	})

	// NOTE: The same for the Type table, which two surfaces read in order:
	// `closestMatch` breaks a tie on the first candidate, so "did you mean …?"
	// would name a different Type, and Completion of a Type annotation ships
	// these unsorted. A conversion moves a name between the halves; neither
	// half may decide where it sits.
	it("orders every builtin Type by name, and names only Types that exist", () => {
		let types = Object.keys(loadStdlib().types)

		expect(
			types.filter((name) => !builtinTypeOrder.includes(name)),
		).toEqual([])
		expect(
			builtinTypeOrder.filter((name) => !types.includes(name)),
		).toEqual([])
	})

	// NOTE: The shared Scope, proven on the REAL standard library rather than a
	// synthetic one. Sorted order hoists `Boolean.es` first, `Ordering.es`
	// fourth and `Protocols.es` fifth, so each of these resolves a name that a
	// file OTHER than its own declares — and two of them resolve one declared
	// in a file that comes after them.
	it("resolves names across standard library files", () => {
		let stdlib = loadStdlib()
		let compareTo = stdlib.protocols["Comparable"]!.methods["compareTo"]!

		expect(compareTo.type).toBe("SimpleMethod")

		if (compareTo.type === "SimpleMethod") {
			// NOTE: The SAME object the `choice Ordering` in `Ordering.es`
			// declared, not a structural twin left behind by a table.
			expect(compareTo.returnType).toBe(stdlib.types["Ordering"]!)
		}

		// NOTE: `Boolean.es` declares no Protocol and is hoisted before the
		// file that does.
		expect(namespaceNamed(stdlib, "Boolean").conformsTo).toEqual([
			"Equatable",
			"Printable",
		])
		expect(namespaceNamed(stdlib, "Ordering").targetType).toBe(
			stdlib.types["Ordering"]!,
		)
	})

	it("caches the loaded standard library", () => {
		expect(loadStdlib()).toBe(loadStdlib())
	})

	// NOTE: What the load cost, in the shape the CLI's Timeline can take.
	it("reports its own timing", () => {
		let stdlib = loadStdlib()

		expect(stdlib.timing.parse).toBeGreaterThanOrEqual(0)
		expect(stdlib.timing.enrich).toBeGreaterThanOrEqual(0)
		expect(stdlib.timing.validate).toBeGreaterThanOrEqual(0)
		expect(stdlib.timing.total).toBeGreaterThanOrEqual(0)
	})

	// NOTE: A standard library file is the WHOLE of what the Namespace it
	// declares contains. Nothing is merged in from anywhere else — a name the
	// sources do not write is a name a Program can not reach, which is what
	// makes `src/stdlib/*.es` readable as the definition of the language.
	it("gives a Namespace exactly what its source declares", () => {
		let stdlib = load([
			"Nothing.es",
			`declarations {
				namespace Nothing for Nothing {
					§§ Whether the value is Nothing.
					isNothing() -> Boolean
				}
			}`,
		])

		expect(Object.keys(namespaceNamed(stdlib, "Nothing").methods)).toEqual([
			"isNothing",
		])
	})
})
