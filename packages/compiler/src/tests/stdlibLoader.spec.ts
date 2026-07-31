import { describe, expect, it } from "bun:test"

import type { common, enricher } from "@essence-lang/interfaces"

import { collectDiagnostics } from "../diagnostics/index"
import { builtinMemberOrder, builtinTypeOrder } from "../enricher/builtins"
import { enrichPrograms } from "../enricher/index"
import { primitiveTypes } from "../enricher/primitives"
import {
	loadStdlib,
	loadStdlibFrom,
	parseStdlibSource,
	type Stdlib,
} from "../enricher/stdlib"
import { parseWithDiagnostics } from "../parser/index"
import { printType } from "../printType"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

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

// NOTE: The same three spellings for a free Function's `overload` block. A free
// Function has no receiver, so the entries are told apart by their Argument
// LABEL — which is what a call site picks the overload by.
const freeOverloadEntries = {
	native: "\t\t(first value: Integer) -> Integer",
	bodiedString:
		"\t\t(second value: String) -> String {\n\t\t\t<- value\n\t\t}",
	bodiedBoolean:
		"\t\t(third value: Boolean) -> Boolean {\n\t\t\t<- value\n\t\t}",
}

function overloadFunction(
	entries: Array<keyof typeof freeOverloadEntries>,
): Stdlib {
	return load([
		"Combine.es",
		`declarations {
	§§ Combines two values.
	overload function combine {
${entries.map((entry) => freeOverloadEntries[entry]).join("\n")}
	}
}`,
	])
}

// NOTE: The typed Nodes a bodied `overload function` block leaves behind, by the
// name each answers to. A free Function is its own top-level Node rather than an
// entry in a Namespace's table, so the numbering is observable directly on the
// typed Program — no simplification needed, the Enricher already named them.
function typedFunctionNames(stdlib: Stdlib): Array<string> {
	return stdlib.typedPrograms[0]!.implementation.nodes.flatMap((node) =>
		node.nodeType === "FunctionStatement" ? [node.name.content] : [],
	)
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
				`import { Optional from "./Fallible.es" }

				declarations {
				namespace Boxes <infer ItemType> for List<ItemType> {
					§§ The first item, if there is one.
					§§ @returns — the first item.
					firstItem() -> Optional<ItemType>

					§§ Wraps a value.
					static wrap <Item>(_ value: Item) -> List<Item>

					§§ How many items the empty Box holds.
					static emptyCount: Integer
				}
			}`,
			],
			// NOTE: `Optional` is declared in Essence now — a nominal Choice
			// with a `Value` payload and an `Empty` Case — so a synthetic
			// library that uses it has to bring its own, and name the file it
			// comes from.
			[
				"Fallible.es",
				`declarations {
				choice Optional<ItemType> {
					Value { item: ItemType },
					Empty,
				}
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
			// NOTE: A builtin has no file to point at — neither for the block
			// as a whole nor for the `@param` lines inside it.
			expect(firstItem.documentation?.position).toBeNull()
			expect(firstItem.documentation?.parameterTags).toBeUndefined()
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

	// NOTE: Across a file boundary through an IMPORT — a standard library file
	// is a Module like any other, and says what it uses. The two are hoisted as
	// one group, so the Protocol still need not be declared before the Namespace
	// conforming to it; what changed is that the conforming file has to name the
	// file it comes from.
	it("resolves a reference across two files", () => {
		let stdlib = load(
			[
				"Namespaces.es",
				`import { Measurable from "./Protocols.es" }

				declarations {
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

	// NOTE: The hoist spans every file, so it runs before any of their
	// collections is open — and the recursive Type pre-pass reports from inside
	// it. Unrouted, those Diagnostics landed in whatever collection surrounded
	// the LOAD: the standard library loads lazily inside the first compile of a
	// process, so a cycle in a library file would enrich "cleanly" file by file
	// and stamp its library positioned errors onto an unrelated user Program.
	it("reports a cycle spanning two files into each file's own Diagnostics", () => {
		let left = parseWithDiagnostics(`implementation {
			type Left = { right: Right, nope: Nope }
		}`)
		let right = parseWithDiagnostics(`implementation {
			type Right = { left: Left }
		}`)
		let scope: enricher.Scope = {
			parent: null,
			members: {},
			declarations: {},
			constants: new Set(),
			types: { ...primitiveTypes },
			protocols: {},
		}

		let { result, diagnostics } = collectDiagnostics(() =>
			enrichPrograms([
				{ program: left.program, scope },
				{ program: right.program, scope },
			]),
		)

		// NOTE: Nothing at all in the surrounding collection — the one that
		// would be the user's Program.
		expect(diagnostics).toEqual([])

		// NOTE: The `unknown-type` comes from the re-resolve that runs AFTER the
		// hoist rounds, which is routed the same way the pre-pass is.
		expect(
			result.map((enriched) =>
				enriched.diagnostics.map((diagnostic) => diagnostic.code),
			),
		).toEqual([
			["recursive-type-declaration", "unknown-type"],
			["recursive-type-declaration"],
		])

		expect(
			result.map((enriched) =>
				enriched.diagnostics.map((diagnostic) => diagnostic.message),
			),
		).toEqual([
			[
				"Type 'Left' names itself through 'Right'",
				"Type 'Nope' is not declared",
			],
			["Type 'Right' names itself through 'Left'"],
		])
	})

	// NOTE: The same routing for what the hoist ROUNDS report. A Warning does
	// not disqualify a speculative resolution — the Type hoists — and since a
	// hoisted Type is reused rather than resolved a second time, the round is
	// the only place that Warning is ever seen. Unrouted it landed in whatever
	// collection surrounded the load, which is how a '@param' typo in a
	// standard library file would have been reported against a user Program.
	it("reports a hoist round's Warning into the file it was written in", () => {
		let left = parseWithDiagnostics(`implementation {
			function greet(subject: String) -> String { <- subject }
		}`)
		let right = parseWithDiagnostics(`implementation {
			§§ Farewells.
			§§ @param subjekt — who to part from
			function part(subject: String) -> String { <- subject }
		}`)
		let scope: enricher.Scope = {
			parent: null,
			members: {},
			declarations: {},
			constants: new Set(),
			types: { ...primitiveTypes },
			protocols: {},
		}

		let { result, diagnostics } = collectDiagnostics(() =>
			enrichPrograms([
				{ program: left.program, scope },
				{ program: right.program, scope },
			]),
		)

		expect(diagnostics).toEqual([])

		expect(
			result.map((enriched) =>
				enriched.diagnostics.map((diagnostic) => diagnostic.code),
			),
		).toEqual([[], ["unknown-documentation-parameter"]])

		// NOTE: Positioned in the file it came from, which is the whole point
		// of handing it over per Node.
		expect(result[1].diagnostics[0].severity).toBe("warning")
		expect(result[1].diagnostics[0].position).toEqual({
			start: { line: 3, column: 14 },
			end: { line: 3, column: 21 },
		})
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
			// nothing of `packages/stdlib/sources` is in scope — so reaching for a real
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
				`import {
					Comparable from "./Ordered.es"
					Ordering from "./Ordered.es"
				}

				declarations {
				namespace Boxes <infer Item> for { value: Item }
					is Comparable where Item is Comparable
				{
					§§ Orders two Boxes by their values.
					compare(to other: { value: Item }) -> Ordering
				}
			}`,
			],
			// NOTE: `Comparable` and `Ordering` are declared in Essence now. The
			// conforming file is linked in the same group as the one declaring
			// the Protocol it conforms to, so the conformance still resolves
			// whichever is hoisted first.
			[
				"Ordered.es",
				`declarations {
				choice Ordering { Less, Equal, Greater }

				protocol Comparable {
					compare(to other: Self) -> Ordering
				}
			}`,
			],
		)

		let namespace = namespaceNamed(stdlib, "Boxes")
		let compare = namespace.methods["compare"]!

		expect(compare.type).toBe("SimpleMethod")

		if (compare.type === "SimpleMethod") {
			expect(compare.generics).toEqual([
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

	// NOTE: A refined Alias and the Namespace answering its predicate may name
	// each other — the exact shape `NonZeroInteger` and `namespace Integer`
	// stand in, with `divide(by NonZeroInteger)` beside the `isNot` the
	// predicate asks — and no single hoisting round can resolve the pair in one
	// breath. The Alias hoists with its predicate unread, the Namespace binds
	// the registered object by reference, and the conjuncts are written into it
	// in place once `isNot` is answerable. The `toBe` is the mechanism in one
	// line: the Parameter's Type IS the Alias' object, not a copy that could
	// have missed the fill.
	it("lets a Namespace answer the predicate its own signatures name", () => {
		let stdlib = load([
			"Integer.es",
			`declarations {
				type NonZero = Integer where @::isNot(0)

				namespace Integer for Integer {
					isNot(_ other: Integer) -> Boolean

					halve(by other: NonZero) -> Integer
				}
			}`,
		])

		let alias = stdlib.types["NonZero"]

		expect(alias?.type).toBe("Refinement")

		if (alias?.type !== "Refinement") {
			throw new Error("'NonZero' did not load as a refinement")
		}

		expect(alias.conjuncts).toEqual([
			{
				namespaceName: "Integer",
				methodName: "isNot",
				overloadIndex: null,
				args: ["0"],
			},
		])

		let halve = namespaceNamed(stdlib, "Integer").methods["halve"]

		expect(halve?.type).toBe("SimpleMethod")

		if (halve?.type !== "SimpleMethod") {
			throw new Error("'halve' did not load as a simple Method")
		}

		expect(halve.parameterTypes[1]?.type).toBe(alias)
	})

	// NOTE: The same deadlock one turn harder. A GENERIC refined Alias hoists as a
	// Generic Alias WRAPPING the pending refinement, and a signature naming
	// `NonEmptyList<Integer>` can not bind that object by reference the way
	// `NonZero` was bound above — applying Type Arguments substitutes them into
	// the base, which means COPYING the refinement, and a copy taken while the
	// predicate is still unread would freeze the null by value. So the copy is
	// refused by throwing: `namespace NonEmptyList` lands back in the rounds, the fill
	// writes the conjuncts in once `namespace List` has answered `hasItems`, and
	// the round after that instantiates cleanly.
	//
	// The `toBe` is that mechanism in one line — the instantiated refinement's
	// conjuncts are the very ARRAY the fill wrote into the Alias, shared by
	// reference, which no copy taken a round too early could be holding. The
	// Namespace's own target is the unbound instantiation, so it stands beside its
	// concrete sibling as proof that both roads through the wrapper arrive.
	it("lets a generic refined Alias be instantiated in the Namespace written for it", () => {
		let stdlib = load([
			"List.es",
			`declarations {
				type NonEmptyList<Item> = List<Item> where @::hasItems()

				namespace List <infer Item> for List<Item> {
					hasItems() -> Boolean
				}

				namespace NonEmptyList <infer Item> for NonEmptyList<Item> {
					firstItem() -> Item

					firstOf(_ numbers: NonEmptyList<Integer>) -> Integer
				}
			}`,
		])

		let alias = stdlib.types["NonEmptyList"]

		expect(alias?.type).toBe("GenericAlias")

		if (
			alias?.type !== "GenericAlias" ||
			alias.aliasedType.type !== "Refinement"
		) {
			throw new Error(
				"'NonEmptyList' did not load as a generic refinement",
			)
		}

		let declared = alias.aliasedType

		expect(declared.base).toEqual({
			type: "List",
			itemType: { type: "GenericUse", name: "Item" },
		})
		expect(declared.conjuncts).toEqual([
			{
				namespaceName: "List",
				methodName: "hasItems",
				overloadIndex: null,
				args: [],
			},
		])

		let namespace = namespaceNamed(stdlib, "NonEmptyList")
		let firstOf = namespace.methods["firstOf"]

		expect(firstOf?.type).toBe("SimpleMethod")

		if (firstOf?.type !== "SimpleMethod") {
			throw new Error("'firstOf' did not load as a simple Method")
		}

		let instantiated = firstOf.parameterTypes[1]?.type

		expect(instantiated?.type).toBe("Refinement")

		if (instantiated?.type !== "Refinement") {
			throw new Error("'firstOf' does not take a refinement")
		}

		expect(instantiated.base).toEqual({
			type: "List",
			itemType: { type: "Integer" },
		})
		expect(instantiated.conjuncts).toBe(declared.conjuncts)
		expect(printType(instantiated)).toBe("NonEmptyList<Integer>")

		// NOTE: The Namespace targets the Alias applied to its own Parameter, which
		// is the same instantiation with nothing bound — the evidence is there, and
		// the spelling stays terse because `NonEmptyList<Item>` would only echo the
		// header.
		let target = namespace.targetType

		expect(target?.type).toBe("Refinement")

		if (target?.type !== "Refinement") {
			throw new Error(
				"'namespace NonEmptyList' does not target a refinement",
			)
		}

		expect(target.conjuncts).toBe(declared.conjuncts)
		expect(printType(target)).toBe("NonEmptyList")
	})

	// NOTE: The deadlock at its tightest, and the shape `List.append(_ item) ->
	// NonEmptyList<ItemType>` needs. The Namespace that ANSWERS the predicate is the
	// one applying the Alias, so no ordering of the rounds can put a resolved
	// predicate in front of it: refusing the copy would send `namespace List` back
	// into the rounds, and the fill would then look for `hasItems` on a Namespace
	// that is not in Scope yet — round after round, until both are given up on. So
	// the copy is TAKEN while the hoist is open and registered against the object it
	// came from, and the fill writes the conjuncts into the Alias and into every
	// copy of it in one breath.
	//
	// Both roads through the wrapper are here, because they are two different
	// substitutions: `NonEmptyList<Integer>` binds the Parameter to a concrete Type,
	// `NonEmptyList<Item>` binds it to the Namespace's own opaque Generic — and each
	// one still COPIES, since the base it builds is a new object either way. The
	// `toBe` is the mechanism in one line: every copy holds the very ARRAY the fill
	// wrote into the Alias.
	it("lets the answering Namespace apply the Alias it answers for", () => {
		let stdlib = load([
			"List.es",
			`declarations {
				type NonEmptyList<Item> = List<Item> where @::hasItems()

				namespace List <infer Item> for List<Item> {
					hasItems() -> Boolean

					append(_ item: Item) -> NonEmptyList<Item>

					firstOf(_ numbers: NonEmptyList<Integer>) -> Integer
				}
			}`,
		])

		let alias = stdlib.types["NonEmptyList"]

		if (
			alias?.type !== "GenericAlias" ||
			alias.aliasedType.type !== "Refinement"
		) {
			throw new Error(
				"'NonEmptyList' did not load as a generic refinement",
			)
		}

		let declared = alias.aliasedType

		expect(declared.conjuncts).toEqual([
			{
				namespaceName: "List",
				methodName: "hasItems",
				overloadIndex: null,
				args: [],
			},
		])

		let namespace = namespaceNamed(stdlib, "List")
		let append = namespace.methods["append"]

		if (append?.type !== "SimpleMethod") {
			throw new Error("'append' did not load as a simple Method")
		}

		let grown = append.returnType

		expect(grown.type).toBe("Refinement")

		if (grown.type !== "Refinement") {
			throw new Error("'append' does not answer with a refinement")
		}

		expect(grown.base).toEqual({
			type: "List",
			itemType: { type: "GenericUse", name: "Item" },
		})
		expect(grown.conjuncts).toBe(declared.conjuncts)
		expect(printType(grown)).toBe("NonEmptyList")

		let firstOf = namespace.methods["firstOf"]

		if (firstOf?.type !== "SimpleMethod") {
			throw new Error("'firstOf' did not load as a simple Method")
		}

		let numbers = firstOf.parameterTypes[1]?.type

		expect(numbers?.type).toBe("Refinement")

		if (numbers?.type !== "Refinement") {
			throw new Error("'firstOf' does not take a refinement")
		}

		expect(numbers.base).toEqual({
			type: "List",
			itemType: { type: "Integer" },
		})
		expect(numbers.conjuncts).toBe(declared.conjuncts)
		expect(printType(numbers)).toBe("NonEmptyList<Integer>")
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

	// NOTE: A Diagnostic has to be rendered against the text of the file it was
	// found in. The files are handed over in file-name order and linked in
	// dependency order, and here those two disagree on purpose: `Alpha.es` sorts
	// first and is linked LAST, because it imports the file that is broken.
	// Pairing the two orders by position would render `Zulu.es`'s Diagnostic
	// against `Alpha.es`'s text, under `Alpha.es`'s name, underlining a line
	// that is fine — and it would not throw while doing it, because the renderer
	// clamps a Position that points past the end of what it was given.
	//
	// Matching the file name alone is not enough to catch that: both names
	// appear in the message either way. The excerpt has to travel with them.
	it("renders a Diagnostic against the file it was found in", () => {
		let load = () =>
			loadStdlibFrom([
				parseStdlibSource(
					"Alpha.es",
					`import { Measurable from "./Zulu.es" }

					declarations {
						namespace Sized for String is Measurable {
							size() -> Integer
						}
					}`,
				),
				parseStdlibSource(
					"Zulu.es",
					`declarations {
						protocol Measurable {
							size() -> Nonexistent
						}
					}`,
				),
			])

		expect(load).toThrow(/Zulu\.es[\s\S]*Nonexistent/)
		expect(load).not.toThrow(/Alpha\.es:[\s\S]*?Nonexistent/)
	})

	// NOTE: `Terminal.es` is reachable from nothing — no standard library file
	// imports `Terminal`, and it imports only `String` and `Printable`. A graph
	// walked from a single entry would leave it out and the language would
	// quietly lose printing altogether, with every other test still green.
	it("loads a file that nothing imports", () => {
		expect(Object.keys(loadStdlib().members)).toContain("Terminal")
	})

	// NOTE: The point of `Prelude.es`. A name reaches the language by being
	// re-exported there and by nothing else, so a Namespace the library needs
	// and the language should not grow simply stays off the list — exported by
	// its own file, imported by its siblings, invisible to every Program. There
	// was no way to write one while every declaration became a builtin.
	it("keeps a Namespace the prelude does not re-export out of the language", () => {
		let stdlib = load(
			[
				"Prelude.es",
				`declarations {}

				export {
					Public from "./Public.es"
				}`,
			],
			[
				"Helpers.es",
				`declarations {
					namespace Internal for String {
						§§ The String, doubled.
						§§ @returns — the String twice over.
						twice() -> String
					}
				}

				export {
					Internal
				}`,
			],
			[
				"Public.es",
				`import { Internal from "./Helpers.es" }

				declarations {
					namespace Public for String {
						§§ The String, four times over.
						§§ @returns — the String four times over.
						quadrupled() -> String {
							<- @::twice()::twice()
						}
					}
				}

				export {
					Public
				}`,
			],
		)

		// NOTE: The helper resolved — `quadrupled` is written on it, and the
		// load throws on any Diagnostic, so reaching here at all proves the
		// import bound.
		expect(Object.keys(stdlib.members)).toContain("Public")
		expect(Object.keys(stdlib.members)).not.toContain("Internal")
	})

	// NOTE: The real library's prelude and its files have to agree. A name
	// exported by a file and forgotten in the prelude is invisible with no
	// Diagnostic anywhere, and the failure it causes is at a use site in some
	// user's Program rather than here.
	it("re-exports every name the standard library declares", () => {
		let stdlib = loadStdlib()
		let available = new Set([
			...Object.keys(stdlib.members),
			...Object.keys(stdlib.types),
			...Object.keys(stdlib.protocols),
		])

		for (let name of [
			"Terminal",
			"Stream",
			"loop",
			"Integer",
			"String",
			"List",
			"NestedList",
			"Optional",
			"NestedOptional",
			"Ordering",
			"Number",
			"Irrational",
			"Rational",
			"Algebraic",
			"Transcendental",
			"Boolean",
			"Record",
			"Step",
			"Side",
			"Case",
			"Rounding",
			"NumberFormat",
			"NormalizationForm",
			"Equatable",
			"Printable",
			"Comparable",
		]) {
			expect(available).toContain(name)
		}
	})

	// NOTE: The bare Type tags are held on a PARENT Scope, and this is the test
	// that says why. `isTaken` — the linker's "is this name already spoken for?"
	// — reads a Scope's own tables and does not walk to its parent. With the
	// tags seeded into the Module's own table, this import would collide with
	// the TAG `Integer` rather than with the Namespace it names, be refused as a
	// `duplicate-import`, and take Integer dispatch down with it.
	it("imports a Namespace that shares a bare Type tag's name", () => {
		let stdlib = load(
			[
				"Counting.es",
				`import { Integer from "./Integer.es" }

				declarations {
					namespace Counting for String {
						size() -> Integer {
							<- 1::doubled()
						}
					}
				}`,
			],
			[
				"Integer.es",
				`declarations {
					namespace Integer for Integer {
						§§ Twice the Integer.
						§§ @returns — twice the Integer.
						doubled() -> Integer
					}
				}`,
			],
		)

		expect(namespaceNamed(stdlib, "Counting").methods["size"]).toBeDefined()
	})

	// NOTE: The cycle search runs per Scope, and it skips a declaration whose
	// name is already in the Scope's OWN Type table. Seeding a Module's table
	// from `builtinTypes()` rather than from a parent holding only the bare tags
	// would make it skip every declaration the file writes — the search would
	// still run, find nothing, and report nothing, on any library.
	it("still reports a recursive Type declaration", () => {
		let load = () =>
			loadStdlibFrom([
				parseStdlibSource(
					"Cycles.es",
					`declarations {
						type Looping = { next: Looping }
					}`,
				),
			])

		expect(load).toThrow(/recursive/i)
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

	// NOTE: The value band's counterpart of the Namespace naming itself: a
	// bodied Property reads one written above it in its own Namespace, and the
	// Rewriter's topological order emits the two consts in that order.
	it("loads a static Property that reads one written above it in its own Namespace", () => {
		let stdlib = load([
			"Constants.es",
			`declarations {
				§ The constants.
				namespace Constants {
					§§ The base value.
					static BASE: Integer = 2

					§§ The base value, read the long way around.
					static ECHO: Integer = Constants.BASE
				}
			}`,
		])

		expect(namespaceNamed(stdlib, "Constants").properties).toEqual({
			BASE: { type: "Integer" },
			ECHO: { type: "Integer" },
		})
	})

	// NOTE: A Property's value is the one Expression enriched while the hoist
	// rounds are still running, which makes it the one place a half-built Scope
	// is observable. The memoised "which Namespaces can this Scope see" answer
	// was recorded there, from the Namespaces hoisted SO FAR, and nothing in the
	// rounds bumped the version that would have retired it — so every Method
	// call in every file afterwards was answered from that table, and a library
	// failed to enrich, in files that had nothing to do with the Property, over
	// one Property that calls a Method. It takes two files to see: the value
	// below names a Namespace the round has not reached yet.
	it("loads a static Property whose value calls a Method hoisted after it", () => {
		let stdlib = load(
			[
				"Constants.es",
				`import { Echoing from "./Echoing.es" }

				declarations {
				§ The constants.
				namespace Constants {
					§§ The base value, read the long way around.
					static ECHO: Integer = 2::echoed()
				}
			}`,
			],
			[
				"Echoing.es",
				`declarations {
				§ The echoing.
				namespace Echoing for Integer {
					§§ The Integer itself.
					§§
					§§ @returns — the Integer.
					echoed() -> Integer {
						<- @
					}
				}
			}`,
			],
		)

		expect(namespaceNamed(stdlib, "Constants").properties).toEqual({
			ECHO: { type: "Integer" },
		})
	})

	// NOTE: The consts are emitted in the order the Properties are written, so a
	// read of one below is a read of a const that does not exist yet. The
	// Validator refuses it, and the standard library's zero-Diagnostic gate
	// turns that into a load that fails rather than a `ReferenceError` at import.
	it("rejects a static Property that reads one written below it in its own Namespace", () => {
		let load = () =>
			loadStdlibFrom([
				parseStdlibSource(
					"Constants.es",
					`declarations {
						§ The constants.
						namespace Constants {
							§§ The base value, read the long way around.
							static ECHO: Integer = Constants.BASE

							§§ The base value.
							static BASE: Integer = 2
						}
					}`,
				),
			])

		expect(load).toThrow(/use-before-declaration/)
		expect(load).toThrow(/Constants\.BASE/)
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
			"Terminal",
			"String",
			"Boolean",
			"Integer",
			// NOTE: The one Namespace a proven Integer can reach besides
			// `Integer`, listed after it for the same reason `NestedList` is
			// listed after `List` — see `builtinMemberOrder`.
			"NonZeroInteger",
			"Rational",
			"Algebraic",
			"Transcendental",
			"Number",
			"Optional",
			// NOTE: The one Namespace an Optional value can reach besides
			// `Optional`, listed after it for the same reason `NestedList` is
			// listed after `List` — see `builtinMemberOrder`. `Optional` has to
			// be searched FIRST for an `Optional<Optional<…>>` receiver, so
			// that `NestedOptional::flatten` reads as the extra a nested
			// Optional has.
			"NestedOptional",
			"Ordering",
			"Side",
			"Case",
			"NormalizationForm",
			"NumberFormat",
			"Rounding",
			"Record",
			"List",
			// NOTE: The two Namespaces a List value can reach besides `List`,
			// listed after it — see `builtinMemberOrder`. `List` has to be
			// searched FIRST for a `List<List<…>>` receiver and for a proven
			// one, so that the narrow Namespace reads as the extra it is.
			"NestedList",
			"NonEmptyList",
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

	// NOTE: A standard library Choice is identified by its BARE name. A Module
	// names its Choices `<modulePath>#<Name>` so that two Modules declaring
	// `choice Colour` stay distinct; a Program that is no Module passes no path
	// and keeps the bare name. Nothing else asserts this directly, and the
	// identity is what the runtime switches on — `Side#Start` and `Step#Done`
	// are written as bare tags in `runtime/String.ts` and `runtime/List.ts`,
	// both behind a `default:` arm, so a qualified identity does not throw. It
	// answers WRONGLY: `trim(at #Start)` trims both ends, and `reduce(step:)`
	// reads `state` off a `#Done` that has none. The golden capture does catch
	// both, at the far end of a compile-and-run; this catches it here.
	it("identifies every standard library Choice by its bare name", () => {
		let types = loadStdlib().types

		let choicesOf = (type: common.Type | undefined): Array<string> => {
			let body =
				type?.type === "GenericAlias"
					? type.aliasedType
					: (type ?? null)

			if (body?.type === "UnionType") {
				return [
					...new Set(
						body.types
							.filter((member) => member.type === "Case")
							.map((member) => member.choice),
					),
				]
			}

			return body?.type === "Case" ? [body.choice] : []
		}

		for (let name of [
			"Ordering",
			"Optional",
			"Side",
			"Case",
			"Step",
			"Rounding",
			"NumberFormat",
			"NormalizationForm",
		]) {
			expect(choicesOf(types[name])).toEqual([name])
		}
	})

	// NOTE: The Protocol table is the one of the three with no order list to
	// cross-check it against, so this states the order outright. It is read in
	// order wherever a conformance is searched, and `Comparable` must stay last
	// — it is the only one whose signature names a Type (`Ordering`) rather
	// than only primitives.
	it("orders the builtin Protocols", () => {
		expect(Object.keys(loadStdlib().protocols)).toEqual([
			"Equatable",
			"Printable",
			"Comparable",
		])
	})

	// NOTE: The order lists above check NAMES. They say nothing about the
	// values, and a name bound to `{ type: "Error" }` — what an unresolvable
	// import is bound to, so that one bad entry does not cascade — passes every
	// one of them while making the builtin useless at every call site. No
	// builtin may ever be an Error.
	it("binds no builtin to an Error Type", () => {
		let stdlib = loadStdlib()

		for (let table of [stdlib.members, stdlib.types, stdlib.protocols]) {
			expect(
				Object.entries(table)
					.filter(([, type]) => type.type === "Error")
					.map(([name]) => name),
			).toEqual([])
		}
	})

	// NOTE: The shared Scope, proven on the REAL standard library rather than a
	// synthetic one. Sorted order hoists `Boolean.es` first, `Ordering.es`
	// fourth and `Protocols.es` fifth, so each of these resolves a name that a
	// file OTHER than its own declares — and two of them resolve one declared
	// in a file that comes after them.
	it("resolves names across standard library files", () => {
		let stdlib = loadStdlib()
		let compare = stdlib.protocols["Comparable"]!.methods["compare"]!

		expect(compare.type).toBe("SimpleMethod")

		if (compare.type === "SimpleMethod") {
			// NOTE: The SAME object the `choice Ordering` in `Ordering.es`
			// declared, not a structural twin left behind by a table.
			expect(compare.returnType).toBe(stdlib.types["Ordering"]!)
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

	// NOTE: A free Function belongs to no Namespace, so its nativeness is kept in
	// `functionBindings` rather than `nativeBindings` — one flag per entry in
	// written order, the same shape a Method's overloads carry, and the same
	// `__overload$N` index. `loop` is the one the real library ships.
	describe("free Functions", () => {
		// NOTE: A user Program enriched against a scope that holds one synthetic
		// free Function and the primitive Type tags — enough for the call sites
		// below to resolve against the declared member without pulling in the real
		// standard library.
		function enrichAgainst(
			member: common.Type,
			source: string,
		): common.typed.Program {
			let members: Record<string, common.Type> = { combine: member }
			let scope: enricher.Scope = {
				parent: null,
				members,
				declarations: {},
				constants: new Set(Object.keys(members)),
				types: { ...primitiveTypes },
				protocols: {},
			}

			let user = parseWithDiagnostics(source)
			let [result] = enrichPrograms([{ program: user.program, scope }])

			expect(result!.diagnostics).toEqual([])

			return result!.program
		}

		// NOTE: Every FunctionInvocation Node anywhere in a Program, typed or
		// simplified — walked structurally so the same helper reads the callee's
		// `content` (typed) or `name` (simplified) off whatever it finds.
		function functionInvocations(program: {
			implementation: { nodes: Array<unknown> }
		}): Array<{
			name: { content?: string; name?: string }
			overloadedMethodIndex: number | null
		}> {
			let found: Array<{
				name: { content?: string; name?: string }
				overloadedMethodIndex: number | null
			}> = []

			let walk = (node: unknown): void => {
				if (node === null || typeof node !== "object") {
					return
				}

				if (
					(node as { nodeType?: string }).nodeType ===
					"FunctionInvocation"
				) {
					found.push(node as (typeof found)[number])
				}

				for (let value of Object.values(node)) {
					if (Array.isArray(value)) {
						value.forEach(walk)
					} else {
						walk(value)
					}
				}
			}

			program.implementation.nodes.forEach(walk)

			return found
		}

		// NOTE: The standalone body-less `function` form left the language with
		// `__print` — a native free Function exists only as an `overload
		// function` entry now, so the loader refuses the signature form at
		// parse.
		it("refuses a body-less free Function", () => {
			expect(() =>
				load([
					"Identity.es",
					`declarations {
						§§ Answers with the value it was given.
						function identity <Item>(_ value: Item) -> Item
					}`,
				]),
			).toThrow()
		})

		// NOTE: A bodied free Function is a single `false` — Essence-implemented,
		// not bound to the runtime.
		it("collects a bodied free Function as one non-native flag", () => {
			let stdlib = load([
				"Identity.es",
				`declarations {
					§§ Answers with the value it was given.
					function identity <Item>(_ value: Item) -> Item {
						<- value
					}
				}`,
			])

			expect(stdlib.functionBindings["identity"]).toEqual([false])
		})

		// NOTE: An `overload function` block keeps its entries in written order,
		// one native flag each, resolving to an `OverloadedStaticMethod` — the
		// same Type a Namespace's static overload set resolves to, which is why
		// `resolveFunctionInvocation` already picks the overload for it.
		it("collects an overloaded free Function's entries in written order", () => {
			let stdlib = load([
				"Combine.es",
				`declarations {
					§§ Combines two values.
					overload function combine {
						§§ From an Integer.
						(first value: Integer) -> Integer
						§§ From a String.
						(second value: String) -> String
					}
				}`,
			])

			expect(stdlib.functionBindings["combine"]).toEqual([true, true])

			let combine = stdlib.members["combine"]!

			expect(combine.type).toBe("OverloadedStaticMethod")

			if (combine.type === "OverloadedStaticMethod") {
				expect(combine.overloads).toHaveLength(2)
				expect(combine.overloads[0]!.returnType).toEqual({
					type: "Integer",
				})
				expect(combine.overloads[1]!.returnType).toEqual({
					type: "String",
				})
			}

			// NOTE: Nothing is emitted for it — the block is all native.
			expect(stdlib.typedPrograms[0]!.implementation.nodes).toEqual([])
		})

		// NOTE: The two halves the mechanism exists for. The Enricher picks the
		// overload from the Argument LABEL — `first` against the Integer entry,
		// `second` against the String — and the Simplifier mangles the bare
		// Identifier callee to the `__overload$N` name that overload's index gives
		// it, exactly as it does a `Namespace.method` Lookup.
		it("resolves an overloaded free Function by label and numbers the emission", () => {
			let stdlib = load([
				"Combine.es",
				`declarations {
					§§ Combines two values.
					overload function combine {
						§§ From an Integer.
						(first value: Integer) -> Integer
						§§ From a String.
						(second value: String) -> String
					}
				}`,
			])

			let program = enrichAgainst(
				stdlib.members["combine"]!,
				`implementation {
					constant a = combine(first 5)
					constant b = combine(second "hi")
				}`,
			)

			expect(
				functionInvocations(program).map(
					(node) => node.overloadedMethodIndex,
				),
			).toEqual([0, 1])

			let simplified = simplify(program)

			expect(
				functionInvocations(simplified).map((node) => node.name.name),
			).toEqual(["combine__overload$1", "combine__overload$2"])
		})

		// NOTE: The free-Function twin of the Method numbering above, and the
		// reason it needs its own proof: a bodied entry becomes a top-level
		// `FunctionStatement` of its own, named by its position in the FUNCTION
		// TYPE rather than by its position among the bodied entries. A native
		// entry's slot is already answered by the runtime export
		// `nativeFreeFunctionNames` spells the same way, so emitting a bodied
		// entry under a filtered index would both answer to a name no call site
		// resolves to and shadow that export.
		describe("numbers a bodied Overload by its position in the Function Type", () => {
			it("skips the slot a leading native occupies", () => {
				let stdlib = overloadFunction(["native", "bodiedString"])

				expect(stdlib.functionBindings["combine"]).toEqual([
					true,
					false,
				])
				expect(typedFunctionNames(stdlib)).toEqual([
					"combine__overload$2",
				])
			})

			it("skips the slot a native between two bodied Overloads occupies", () => {
				let stdlib = overloadFunction([
					"bodiedString",
					"native",
					"bodiedBoolean",
				])

				expect(stdlib.functionBindings["combine"]).toEqual([
					false,
					true,
					false,
				])
				expect(typedFunctionNames(stdlib)).toEqual([
					"combine__overload$1",
					"combine__overload$3",
				])
			})

			it("skips the slots two leading natives occupy", () => {
				let stdlib = overloadFunction([
					"native",
					"native",
					"bodiedString",
				])

				expect(typedFunctionNames(stdlib)).toEqual([
					"combine__overload$3",
				])
			})

			// NOTE: The Node carries the Type of the slot it was NUMBERED for, not
			// of the first overload nor of the filtered position — the Type a call
			// site that resolved to that index has already committed to.
			it("gives the Node the Type of its own slot", () => {
				let stdlib = overloadFunction(["native", "bodiedString"])
				let [node] = stdlib.typedPrograms[0]!.implementation.nodes

				expect(node?.nodeType).toBe("FunctionStatement")

				if (node?.nodeType === "FunctionStatement") {
					expect(node.type.type).toBe("Function")

					if (node.type.type === "Function") {
						expect(node.type.returnType).toEqual({
							type: "String",
						})
					}
				}
			})

			// NOTE: The failure the numbering exists to prevent, stated over the
			// mixed shapes: no bodied entry ever takes a native entry's name, and
			// exactly the bodied ones are emitted.
			it("never emits a definition under a native's export name", () => {
				for (let entries of [
					["native", "bodiedString"],
					["bodiedString", "native", "bodiedBoolean"],
					["native", "native", "bodiedString"],
				] as const) {
					let stdlib = overloadFunction([...entries])
					let flags = stdlib.functionBindings["combine"]!
					let emitted = new Set(typedFunctionNames(stdlib))

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

			// NOTE: The other half of the invariant — where nothing is native the
			// indices are the identity, which is the shape `loop`'s two bodied
			// entries and every user-written `overload function` rely on.
			it("numbers an all bodied block from one, in order", () => {
				let stdlib = overloadFunction(["bodiedString", "bodiedBoolean"])

				expect(stdlib.functionBindings["combine"]).toEqual([
					false,
					false,
				])
				expect(typedFunctionNames(stdlib)).toEqual([
					"combine__overload$1",
					"combine__overload$2",
				])
			})
		})

		// NOTE: A bare reference to an overloaded free Function names every
		// overload at once, which no later invocation could disambiguate — the
		// Validator refuses it in value position.
		it("refuses an overloaded free Function used as a value", () => {
			let stdlib = load([
				"Combine.es",
				`declarations {
					§§ Combines two values.
					overload function combine {
						§§ From an Integer.
						(first value: Integer) -> Integer
						§§ From a String.
						(second value: String) -> String
					}
				}`,
			])

			let program = enrichAgainst(
				stdlib.members["combine"]!,
				`implementation {
					constant f = combine
				}`,
			)

			let diagnostics = validate(program)

			expect(
				diagnostics.some(
					(diagnostic) =>
						diagnostic.code === "overloaded-function-value",
				),
			).toBe(true)
		})

		// NOTE: Every Documentation a consumer reaches must be sourceless — an
		// overloaded free Function's set-level and per-overload Documentation
		// alike, exactly as an `overload` Method block's are.
		it("strips the Documentation Positions off an overloaded free Function", () => {
			let stdlib = load([
				"Combine.es",
				`declarations {
					§§ Combines two values.
					overload function combine {
						§§ From an Integer.
						(first value: Integer) -> Integer
						§§ From a String.
						(second value: String) -> String
					}
				}`,
			])

			let combine = stdlib.members["combine"]!

			expect(combine.type).toBe("OverloadedStaticMethod")

			if (combine.type === "OverloadedStaticMethod") {
				expect(combine.documentation?.description).toBe(
					"Combines two values.",
				)
				expect(combine.documentation?.position).toBeNull()

				for (let overload of combine.overloads) {
					expect(overload.documentation?.position).toBeNull()
				}
			}
		})
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
	// declares contains. No member is merged in from anywhere else — a name the
	// sources do not write is a name a Program can not reach, which is what
	// makes `packages/stdlib/sources/*.es` readable as the definition of the language.
	//
	// NOTE: The file name and the Namespace name are both taken from a REAL
	// standard library file, which is what makes the claim worth pinning: the
	// loader is given one synthetic `Boolean.es` and answers with exactly the
	// one Method that file writes. `negate`, `is`, `isNot`, `and`, `or`,
	// `exclusiveOr` and `toString` — everything the shipped `Boolean.es`
	// declares — are absent, so nothing is keyed off the name and filled in
	// behind the source's back.
	it("gives a Namespace exactly what its source declares", () => {
		let stdlib = load([
			"Boolean.es",
			`declarations {
				namespace Boolean for Boolean {
					§§ Whether the value is true.
					isTrue() -> Boolean
				}
			}`,
		])

		expect(Object.keys(namespaceNamed(stdlib, "Boolean").methods)).toEqual([
			"isTrue",
		])
	})
})
