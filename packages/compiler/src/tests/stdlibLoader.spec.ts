import { describe, expect, it } from "bun:test"

import type { common, enricher } from "@essence-lang/interfaces"
import {
	readStdlibFiles,
	STDLIB_DIRECTORY,
} from "@essence-lang/standard-library"

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

// The emitted Method names of one Namespace of a synthetic standard library,
// where the `__overload$N` numbering shows.
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

// Overload entries for the numbering: one bound to the runtime and two
// written in Essence with distinct signatures.
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

// The same for a free Function's `overload` block. With no receiver, the
// entries are told apart by their Argument labels, as a call site picks them.
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

// The names of the typed Nodes a bodied `overload function` block leaves. A
// free Function is a top-level Node, so the Enricher's numbering shows on the
// typed Program.
function typedFunctionNames(stdlib: Stdlib): Array<string> {
	return stdlib.typedPrograms[0]!.implementation.nodes.flatMap((node) =>
		node.nodeType === "FunctionStatement" ? [node.name.content] : [],
	)
}

describe("Standard Library Loader", () => {
	// In a `declarations { … }` block a signature without a body is the
	// declaration. Its Method Types, Type Parameters, Documentation and native
	// bindings all come from signatures alone.
	it("resolves a native Namespace into a complete Namespace Type", () => {
		let stdlib = load(
			[
				"Boxes.es",
				`import { from "./Fallible.es" { Optional } }

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
			// `Optional` is declared in Essence, so a synthetic library that
			// uses it brings its own and imports it.
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
			// The receiver Parameter is injected as for a bodied Method, and the
			// Namespace Generic the signature mentions is merged in.
			expect(firstItem.parameterTypes).toHaveLength(1)
			expect(firstItem.generics.map((generic) => generic.name)).toEqual([
				"ItemType",
			])
			expect(firstItem.documentation?.description).toBe(
				"The first item, if there is one.",
			)
			// A builtin has no file to point at, for the block or its `@param`
			// lines.
			expect(firstItem.documentation?.position).toBeNull()
			expect(
				firstItem.documentation?.parameters.every(
					(parameter) => parameter.tag === undefined,
				),
			).toBe(true)
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

		// A native has no body, so it is in the Type tables but not the tree.
		let typed = namespaceNodeIn(stdlib.typedPrograms[0]!, "Boxes")

		expect(Object.keys(typed.methods)).toEqual([])
		expect(Object.keys(typed.properties)).toEqual([])
	})

	// An `overload` block may mix native and bodied entries. The index picks
	// the `__overload$N` name, so a native keeps its slot in the resolved Type.
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

		// Only the bodied Overload reaches the typed tree.
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

	// The suffix is the Overload's position in the Method Type, not in the
	// typed Node. See "Overload slots" in
	// packages/compiler/src/simplifier/DEVELOPMENT.md.
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

		// A native's runtime export answers to its slot's name, so a bodied
		// definition under that name would replace a different Overload.
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

		// With nothing native the slots are the written positions, as every
		// `overload` block a user writes relies on.
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

	// A standard library file is a Module and imports what it uses. The files
	// hoist as one group, so a Protocol need not be declared before the
	// Namespace conforming to it.
	it("resolves a reference across two files", () => {
		let stdlib = load(
			[
				"Namespaces.es",
				`import { from "./Protocols.es" { Measurable } }

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

	// The hoist spans every file and runs before any file's collection opens.
	// Its reports are routed to their own files. The library loads inside the
	// first compile, and its errors must not land on a user's Program.
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

		// Nothing reaches the surrounding collection, which would be the user's.
		expect(diagnostics).toEqual([])

		// The `unknown-type` comes from the re-resolve after the hoist rounds,
		// which is routed the same way.
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

	// The same routing for the hoist rounds. A Warning does not stop a Type
	// hoisting, and a hoisted Type is not resolved again. So the round is the
	// only place its Warning is seen.
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
		).toEqual([[], ["misnamed-documentation-parameter"]])

		// Positioned in the file it came from.
		expect(result[1].diagnostics[0].severity).toBe("warning")
		expect(result[1].diagnostics[0].position).toEqual({
			start: { line: 3, column: 14 },
			end: { line: 3, column: 21 },
		})
	})

	// A bodied Method survives into the typed tree, from which the Rewriter
	// builds the prelude.
	it("keeps a bodied Method's typed Node", () => {
		let stdlib = load([
			"Bodied.es",
			// A synthetic library sees only the bare Type tags and its own
			// sources, so the body calls a native sibling rather than a builtin.
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

	// A native Method has a resolved Type and witnesses but no typed Node. Its
	// Type must still carry the bound Namespace Generic for the hidden
	// conformance Parameter its call sites pass.
	it("retains a bound Namespace Generic on a native fulfilling Method", () => {
		let stdlib = load(
			[
				"Boxes.es",
				`import {
					from "./Ordered.es" { Comparable }
					from "./Ordered.es" { Ordering }
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
			// Both files hoist as one group, so the conformance resolves
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

		// There is no typed Node to keep in step.
		let typed = namespaceNodeIn(stdlib.typedPrograms[0]!, "Boxes")

		expect(Object.keys(typed.methods)).toEqual([])
	})

	// A refined Alias and the Namespace answering its predicate name each
	// other. The Parameter's Type is the Alias' own object, filled in place.
	// See "Reading a refined Alias" in packages/compiler/src/enricher/DEVELOPMENT.md.
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

		// This bodiless `isNot` is a leaf of its own. The standard library's
		// resolves through `Equatable`'s provided body to `is`.
		expect(alias.conjuncts).toEqual([
			{
				namespaceName: "Integer",
				methodName: "isNot",
				negated: false,
				args: ["0"],
				spelling: { methodName: "isNot", args: ["0"] },
			},
		])

		let halve = namespaceNamed(stdlib, "Integer").methods["halve"]

		expect(halve?.type).toBe("SimpleMethod")

		if (halve?.type !== "SimpleMethod") {
			throw new Error("'halve' did not load as a simple Method")
		}

		expect(halve.parameterTypes[1]?.type).toBe(alias)
	})

	// Applying a generic refined Alias copies the refinement, and every copy
	// holds the conjuncts array the fill wrote into the Alias. See "Unresolved
	// refinements" in packages/interfaces/DEVELOPMENT.md.
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
			// This bodiless `hasItems` is a leaf of its own. The standard
			// library's resolves to `@::isEmpty()::negate()`.
			{
				namespaceName: "List",
				methodName: "hasItems",
				negated: false,
				args: [],
				spelling: { methodName: "hasItems", args: [] },
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

		// The Namespace targets the Alias applied to its own Parameter, which
		// prints tersely rather than echo the header.
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

	// The Namespace answering the predicate applies the Alias itself, as
	// `List.append` does. Refusing the copy would deadlock, so it is registered
	// while the hoist is open and the fill writes every copy. Both a concrete and
	// an opaque Type Argument copy, and each holds the fill's array.
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
			// This bodiless `hasItems` is a leaf of its own. The standard
			// library's resolves to `@::isEmpty()::negate()`.
			{
				namespaceName: "List",
				methodName: "hasItems",
				negated: false,
				args: [],
				spelling: { methodName: "hasItems", args: [] },
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

	// A Diagnostic in the standard library is a Compiler developer's error, and
	// later stages would run on a half-built Scope. So it is thrown, rendered
	// as the CLI prints it.
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

	// The files share one Scope, so a mistake where something is declared also
	// fails every file that uses it. Reporting only the first failure would
	// hide the cause.
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

	// A Diagnostic has to be rendered against the text of the file it was
	// found in. Files arrive in name order but link in dependency order, and
	// `Alpha.es` sorts first yet links last. Pairing the orders by position
	// would render `Zulu.es`'s Diagnostic against `Alpha.es`, and the renderer
	// clamps rather than throws. Both names appear either way, so the excerpt is
	// checked.
	it("renders a Diagnostic against the file it was found in", () => {
		let load = () =>
			loadStdlibFrom([
				parseStdlibSource(
					"Alpha.es",
					`import { from "./Zulu.es" { Measurable } }

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

	// `refuseUnexpectedCycles` freezes the graph's shape, and this spec holds
	// its comparison. See "The shape of the graph is frozen" in
	// packages/standard-library/DEVELOPMENT.md. The guard applies to files under
	// `STDLIB_DIRECTORY`, so sources named there count as the real library.
	const CYCLE_SOURCES: Array<[string, string]> = [
		[
			"Aye.es",
			`import { from "./Bee.es" { Bee } }

			declarations {
				type Aye = Integer

				namespace Aye for Aye {
					§§ The Bee this Aye stands for.
					§§ @returns — the Bee.
					bee() -> Bee
				}
			}`,
		],
		[
			"Bee.es",
			`import { from "./Aye.es" { Aye } }

			declarations {
				type Bee = String

				namespace Bee for Bee {
					§§ The Aye this Bee stands for.
					§§ @returns — the Aye.
					aye() -> Aye
				}
			}`,
		],
	]

	it("refuses a cycle the library did not decide on", () => {
		let load = () =>
			loadStdlibFrom(
				CYCLE_SOURCES.map(([fileName, source]) =>
					parseStdlibSource(
						`${STDLIB_DIRECTORY}/${fileName}`,
						source,
					),
				),
			)

		expect(load).toThrow(/dependency graph changed shape/)
		expect(load).toThrow(
			/Algebraic\.es, Integer\.es, List\.es, Rational\.es, String\.es, Transcendental\.es/,
		)
		expect(load).toThrow(/Optional\.es, Result\.es/)
		expect(load).toThrow(/Found 1:\n  Aye\.es, Bee\.es/)
	})

	// The frozen set is about the real library's files, so a test library may
	// have any shape.
	it("leaves a test library's own cycles alone", () => {
		expect(() => load(...CYCLE_SOURCES)).not.toThrow()
	})

	// Every library file loads, not only those another file imports. Nothing
	// imports `Lonely.es`, so its Namespace stays out of the language. Its typed
	// Program is still there, and a mistake in it stops the load.
	it("loads a file that nothing imports", () => {
		let prelude: [string, string] = [
			"Prelude.es",
			`declarations {}

			export {
				from "./Public.es" { Public }
			}`,
		]
		let reached: [string, string] = [
			"Public.es",
			`declarations {
				namespace Public for String {
					§§ The String, as it is.
					§§ @returns — the same String.
					same() -> String {
						<- @
					}
				}
			}

			export {
				Public
			}`,
		]
		let lonely = (answer: string): [string, string] => [
			"Lonely.es",
			`declarations {
				namespace Lonely for String {
					§§ The String, as it is.
					§§ @returns — the same String.
					same() -> String {
						<- ${answer}
					}
				}
			}

			export {
				Lonely
			}`,
		]

		let stdlib = load(prelude, reached, lonely("@"))

		expect(Object.keys(stdlib.members)).not.toContain("Lonely")
		expect(
			namespaceNodeIn(stdlib.typedPrograms[2]!, "Lonely").name.content,
		).toBe("Lonely")
		expect(() => load(prelude, reached, lonely("1"))).toThrow(/Lonely\.es/)
	})

	// A name reaches the language only through `Prelude.es`. A Namespace
	// exported by its own file and imported by its siblings stays invisible to
	// every Program.
	it("keeps a Namespace the prelude does not re-export out of the language", () => {
		let stdlib = load(
			[
				"Prelude.es",
				`declarations {}

				export {
					from "./Public.es" { Public }
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
				`import { from "./Helpers.es" { Internal } }

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

		// The load throws on any Diagnostic, so reaching here proves that
		// `quadrupled` found its helper.
		expect(Object.keys(stdlib.members)).toContain("Public")
		expect(Object.keys(stdlib.members)).not.toContain("Internal")
	})

	// A name a file exports but the prelude forgets is invisible with no
	// Diagnostic, failing only at a use site in some Program.
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
			"OptionalList",
			"Optional",
			"NestedOptional",
			"Result",
			"NestedResult",
			"ResultList",
			"Ordering",
			"Number",
			"Irrational",
			"Scalar",
			"Rational",
			"Algebraic",
			"Transcendental",
			"Boolean",
			"Record",
			"Dictionary",
			"Step",
			"Side",
			"CaseSensitivity",
			"Rounding",
			"SignStyle",
			"Division",
			"NumberFormat",
			"NormalizationForm",
			"SortOrder",
			"Equatable",
			"Printable",
			"Comparable",
		]) {
			expect(available).toContain(name)
		}
	})

	// The bare Type tags live on a parent Scope, since the linker's `isTaken`
	// reads only a Scope's own tables. Otherwise importing `Integer` would
	// collide with the tag as a `duplicate-import`.
	it("imports a Namespace that shares a bare Type tag's name", () => {
		let stdlib = load(
			[
				"Counting.es",
				`import { from "./Integer.es" { Integer } }

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

	// The cycle search skips a declaration already in the Scope's own Type
	// table. Seeding a Module's table from `builtinTypes()` would make it skip
	// every declaration and report nothing.
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

	// A native Property is its annotation, so one without a Type is refused
	// rather than resolved silently to Error.
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

	// A bodied Property may read one written before it in its own Namespace,
	// and the Rewriter emits the two consts in that order.
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

	// A Property's value is enriched while the hoist rounds run, against a
	// half-built Scope. A memo of the Namespaces visible then must not outlive
	// the round. The value calls a Method from a file not hoisted yet.
	it("loads a static Property whose value calls a Method hoisted after it", () => {
		let stdlib = load(
			[
				"Constants.es",
				`import { from "./Echoing.es" { Echoing } }

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

	// The consts are emitted in written order, so reading a later Property
	// reads a const not yet defined. The Validator refuses it, so the load fails
	// rather than throw a `ReferenceError` at import.
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

	// `NumberList.es` calls the `Comparable`-bounded `@::sort()` without
	// importing `Comparable`, since a bound is resolved in the callee's Module.
	it("loads a file whose bounded calls name a Protocol it does not import", () => {
		let sources = readStdlibFiles().map(({ filePath, sourceText }) =>
			parseStdlibSource(filePath, sourceText),
		)
		let numberList = sources.find((source) =>
			source.fileName.endsWith("/NumberList.es"),
		)

		expect(numberList?.sourceText).toContain("@::sort()")
		expect(numberList?.sourceText).not.toContain('"./Comparable.es"')
		expect(() => loadStdlibFrom(sources)).not.toThrow()
	})

	// A standard library Protocol's identity carries no path, and the
	// file that declares it publishes it all the same.
	it("names the file that declares a Protocol a bound names unimported", () => {
		let load = () =>
			loadStdlibFrom([
				parseStdlibSource(
					"/std/A.es",
					`declarations {
	protocol Sized {
		size() -> Integer
	}

	function helper() -> Integer {
		<- 1
	}
}
`,
				),
				parseStdlibSource(
					"/std/B.es",
					`import {
	from "./A.es" { helper }
}

declarations {
	function measure <infer Item is Sized>(_ item: Item) -> Integer {
		<- helper()
	}
}
`,
				),
			])

		expect(load).toThrow("'Sized' is declared in A.es — import it here.")
	})

	// Documentation a consumer reaches carries no Position, since consumers of
	// these tables have no standard library file to point into.
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

	// An `implementation { … }` file cannot declare a native, so accepting one
	// would drop the Methods it was written to add.
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

	// The member table follows `builtinMemberOrder`, not file order, so
	// renaming `List.es` cannot reorder Completion or the Namespace search.
	it("lists the builtin Namespaces in one order, whatever the file names", () => {
		expect(
			loadStdlib().namespaces.map((namespace) => namespace.name),
		).toEqual([
			"Terminal",
			"String",
			// Each proven Namespace follows the one it narrows. See
			// `builtinMemberOrder` for every placement.
			"NonEmptyString",
			"Boolean",
			"Integer",
			"NonZeroInteger",
			"NonNegativeInteger",
			"PositiveInteger",
			"Rational",
			"NonZeroRational",
			"NonNegativeRational",
			"PositiveRational",
			"Scalar",
			"Algebraic",
			"Transcendental",
			"Number",
			"Optional",
			// `Optional` is searched first for a nested receiver.
			"NestedOptional",
			"Result",
			"NestedResult",
			"Ordering",
			"Side",
			"CaseSensitivity",
			"NormalizationForm",
			"NumberFormat",
			"Rounding",
			"SignStyle",
			"Division",
			"SortOrder",
			"Stream",
			"HttpMethod",
			"Redirects",
			"Record",
			"List",
			// `List` is searched first for a nested or a proven receiver.
			"NestedList",
			"OptionalList",
			"ResultList",
			"NonEmptyList",
			"NonEmptyNestedList",
			"IntegerList",
			"RationalList",
			"NumberList",
			"NonEmptyIntegerList",
			"NonEmptyRationalList",
			"NonEmptyNumberList",
			"KeyedNumberList",
			"NonEmptyKeyedNumberList",
			"Dictionary",
			"NonEmptyDictionary",
			"GroupedList",
			"GroupedNonEmptyList",
			"Randomness",
			"Future",
			"ResultFuture",
			"FutureList",
			"NonEmptyFutureList",
			"ResultFutureList",
			"Started",
			"Async",
			"Http",
			"Response",
			"HttpFailure",
		])
	})

	// The load time follows the declared surface, which a clock cannot guard
	// steadily, so the entries are counted. A change that adds entries updates
	// the count, as `README.md` states it. See "What to weigh before writing the
	// next one" in packages/standard-library/DEVELOPMENT.md.
	it("counts the declared entries a load pays for", () => {
		let stdlib = loadStdlib()
		let entries = 0

		for (let namespace of stdlib.namespaces) {
			for (let method of Object.values(namespace.methods)) {
				entries +=
					method.type === "OverloadedMethod" ||
					method.type === "OverloadedStaticMethod"
						? method.overloads.length
						: 1
			}
		}

		for (let flags of Object.values(stdlib.functionBindings)) {
			entries += flags.length
		}

		expect(stdlib.namespaces).toHaveLength(62)
		expect(entries).toBe(750)
	})

	// `builtinMemberOrder` is the only source of order. A listed name that no
	// longer exists misleads, and an unlisted member would be appended last.
	it("orders every builtin member by name, and names only members that exist", () => {
		let members = Object.keys(loadStdlib().members)

		expect(
			members.filter((name) => !builtinMemberOrder.includes(name)),
		).toEqual([])
		expect(
			builtinMemberOrder.filter((name) => !members.includes(name)),
		).toEqual([])
	})

	// The Type table is read in order too: `closestMatch` breaks a tie on the
	// first candidate, and Completion of a Type annotation lists them unsorted.
	it("orders every builtin Type by name, and names only Types that exist", () => {
		let types = Object.keys(loadStdlib().types)

		expect(
			types.filter((name) => !builtinTypeOrder.includes(name)),
		).toEqual([])
		expect(
			builtinTypeOrder.filter((name) => !types.includes(name)),
		).toEqual([])
	})

	// A standard library Choice keeps its bare name, unlike a Module's. The
	// runtime compares bare tags such as `Side#Start` and `Step#Done`, and a
	// qualified tag would answer wrongly rather than throw.
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
			"Result",
			"Side",
			"CaseSensitivity",
			"Step",
			"Rounding",
			"SignStyle",
			"Division",
			"NumberFormat",
			"NormalizationForm",
			"SortOrder",
		]) {
			expect(choicesOf(types[name])).toEqual([name])
		}
	})

	// The Protocol table has no order list, so this states its order. A
	// conformance search reads it in order. `Orderable` follows `Comparable`,
	// which it extends.
	it("orders the builtin Protocols", () => {
		expect(Object.keys(loadStdlib().protocols)).toEqual([
			"Equatable",
			"Printable",
			"Comparable",
			"Orderable",
			"Enumerable",
			"Generatable",
		])
	})

	// A standard library Protocol is known by its bare name, which holds
	// only while no two files declare a Protocol of one name.
	it("declares every Protocol under a name no other file declares", () => {
		let declared = readStdlibFiles().flatMap(({ filePath, sourceText }) =>
			parseStdlibSource(
				filePath,
				sourceText,
			).program.implementation.nodes.flatMap((node) =>
				node.nodeType === "ProtocolDeclarationStatement"
					? [node.name.content]
					: [],
			),
		)
		let protocols = loadStdlib().protocols

		expect(declared.length).toBeGreaterThan(0)
		expect(new Set(declared).size).toBe(declared.length)
		expect(
			Object.values(protocols).map((protocol) => protocol.identity),
		).toEqual(Object.keys(protocols))
	})

	// The order lists check names only. An unresolvable import binds a name to
	// an Error, which would pass them, so no builtin may be an Error.
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

	// The shared Scope on the real standard library. Each assertion resolves a
	// name another file declares.
	it("resolves names across standard library files", () => {
		let stdlib = loadStdlib()
		let compare = stdlib.protocols["Comparable"]!.methods["compare"]!

		expect(compare.type).toBe("SimpleMethod")

		if (compare.type === "SimpleMethod") {
			// The very object `Ordering.es` declared, not a structural twin.
			expect(compare.returnType).toBe(stdlib.types["Ordering"]!)
		}

		// `Boolean.es` sorts before `Comparable.es` and still conforms to
		// `Comparable`.
		expect(namespaceNamed(stdlib, "Boolean").conformsTo).toEqual([
			"Equatable",
			"Printable",
			"Comparable",
		])
		expect(namespaceNamed(stdlib, "Ordering").targetType).toBe(
			stdlib.types["Ordering"]!,
		)
	})

	// A free Function belongs to no Namespace, so its flags live in
	// `functionBindings`, one per entry in written order. The index matches a
	// Method's `__overload$N`. The real library ships `loop`.
	describe("free Functions", () => {
		// Enriches a Program against one synthetic free Function and the
		// primitive Type tags, without the real standard library.
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

		// Every FunctionInvocation Node in a typed or simplified Program, found
		// by a structural walk.
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

		// A native free Function exists only as an `overload function` entry,
		// so a bodiless `function` is refused.
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

		// A bodied free Function is one `false`, written in Essence.
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

		// An `overload function` block resolves to an `OverloadedStaticMethod`,
		// like a static overload set, so `resolveFunctionInvocation` picks its
		// entries.
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

			// The block is all native, so nothing is emitted.
			expect(stdlib.typedPrograms[0]!.implementation.nodes).toEqual([])
		})

		// The Enricher picks the entry by label, and the Simplifier mangles the
		// bare callee to its `__overload$N` name, as for a `Namespace.method`.
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

		// A bodied entry becomes its own top-level `FunctionStatement`, named by
		// its slot in the Function Type. A native slot is the runtime export
		// `nativeFreeFunctionNames` spells the same way.
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

			// The Node carries the Type of its own slot, which a call site that
			// resolved to that index committed to.
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

			// No bodied entry takes a native's name, and only bodied entries are
			// emitted.
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

			// With nothing native, slots are the written positions.
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

		// A bare reference to an overloaded free Function names every entry at
		// once, so the Validator refuses it as a value.
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

		// Its set-level and per-entry Documentation carry no Position either.
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

	// The library is loaded once per process, and every consumer reads the
	// same object.
	it("caches the loaded standard library", () => {
		expect(loadStdlib()).toBe(loadStdlib())
	})

	// What the load cost, in the shape the CLI's Timeline can take.
	it("reports its own timing", () => {
		let stdlib = loadStdlib()

		expect(stdlib.timing.parse).toBeGreaterThanOrEqual(0)
		expect(stdlib.timing.enrich).toBeGreaterThanOrEqual(0)
		expect(stdlib.timing.validate).toBeGreaterThanOrEqual(0)
		expect(stdlib.timing.total).toBeGreaterThanOrEqual(0)
	})

	// Every Boolean Method the library writes: predicate aliases with the leaf
	// each resolves to (`#0` is the caller's Argument), then primitives. See
	// "Predicate aliases" in packages/compiler/src/enricher/DEVELOPMENT.md. A
	// chain or a Function Argument makes a primitive. `predicateEval.ts` and the
	// generator's narrowing hold primitives alone, so a change here reaches them.
	it("reads every predicate the standard library writes off its body", () => {
		let stdlib = loadStdlib()
		let aliases: Array<string> = []
		let primitives: Array<string> = []

		function readingOf(
			owner: string,
			methodName: string,
			entry: common.BaseFunction,
		): void {
			if (entry.returnType.type !== "Boolean") {
				return
			}

			let alias = entry.predicateAlias

			if (alias === undefined) {
				primitives.push(`${owner}::${methodName}`)

				return
			}

			let args = alias.args
				.map((slot) =>
					slot.kind === "Literal"
						? String(slot.value)
						: `#${slot.index}`,
				)
				.join(", ")

			aliases.push(
				`${owner}::${methodName} -> ${alias.negated ? "not " : ""}${
					alias.namespaceName ?? "Self"
				}::${alias.methodName}(${args})`,
			)
		}

		for (let [name, member] of Object.entries(stdlib.members)) {
			if (member.type !== "Namespace") {
				continue
			}

			for (let [methodName, method] of Object.entries(member.methods)) {
				if (method.type === "SimpleMethod") {
					readingOf(name, methodName, method)
				} else if (method.type === "OverloadedMethod") {
					for (let entry of method.overloads) {
						readingOf(name, methodName, entry)
					}
				}
			}
		}

		for (let [name, protocol] of Object.entries(stdlib.protocols)) {
			for (let [methodName, method] of Object.entries(protocol.methods)) {
				// A Protocol's table holds its ancestors' entries too. Each body is
				// one row, under the Protocol that wrote it, as `protocolsProviding`
				// reads a call.
				if (
					protocol.providedMethods?.[methodName] !== undefined &&
					protocol.providedMethods[methodName] !== name
				) {
					continue
				}

				if (method.type === "SimpleMethod") {
					readingOf(`protocol ${name}`, methodName, method)
				}
			}
		}

		// Deduplicated, since two Overloads asking one question are one row, as
		// with `Integer::isLessThanOrEqualTo`'s Integer and Rational bounds.
		expect([...new Set(aliases)].sort()).toEqual([
			"Boolean::exclusiveOr -> not Boolean::is(#0)",
			"Dictionary::hasEntries -> not Dictionary::isEmpty()",
			"Dictionary::hasNoEntries -> not Dictionary::hasEntries(#0)",
			"Integer::isGreaterThanOrEqualTo -> not Integer::isLessThan(#0)",
			"Integer::isLessThanOrEqualTo -> not Integer::isGreaterThan(#0)",
			"Integer::isNegative -> Integer::isLessThan(0)",
			"Integer::isNot -> not Integer::is(#0)",
			"Integer::isOdd -> not Integer::isEven()",
			"Integer::isPositive -> Integer::isGreaterThan(0)",
			"Integer::isZero -> Integer::is(0)",
			"List::doesNotContain -> not List::contains(#0)",
			"List::doesNotEnd -> not List::ends(#0)",
			"List::doesNotStart -> not List::starts(#0)",
			"List::hasItems -> not List::isEmpty()",
			"List::hasNoItems -> not List::hasItems(#0)",
			"Optional::isEmpty -> not Optional::hasValue()",
			"Optional::isNot -> not Optional::is(#0)",
			"Rational::isGreaterThanOrEqualTo -> not Rational::isLessThan(#0)",
			"Rational::isLessThanOrEqualTo -> not Rational::isGreaterThan(#0)",
			"Rational::isNegative -> Rational::isLessThan(0/1)",
			"Rational::isNot -> not Rational::is(#0)",
			"Rational::isPositive -> Rational::isGreaterThan(0/1)",
			"Rational::isZero -> Rational::is(0/1)",
			"Result::hasFailed -> not Result::hasValue()",
			"Result::isNot -> not Result::is(#0)",
			"String::doesNotContain -> not String::contains(#0)",
			// The folding entry is a row of its own, since a call naming a
			// `CaseSensitivity` asks a different question.
			"String::doesNotContain -> not String::contains(#0, #1)",
			"String::doesNotEnd -> not String::ends(#0)",
			"String::doesNotEnd -> not String::ends(#0, #1)",
			"String::doesNotStart -> not String::starts(#0)",
			"String::doesNotStart -> not String::starts(#0, #1)",
			"String::hasCharacters -> not String::isEmpty()",
			"Transcendental::isNegative -> not Transcendental::isPositive()",
			"protocol Comparable::isGreaterThanOrEqualTo -> not Self::isLessThan(#0)",
			"protocol Comparable::isLessThanOrEqualTo -> not Self::isGreaterThan(#0)",
			"protocol Equatable::isNot -> not Self::is(#0)",
		])

		expect([...new Set(primitives)].sort()).toEqual([
			"Algebraic::is",
			"Algebraic::isNegative",
			"Algebraic::isPositive",
			// Both answer a literal rather than a call. They exist because a
			// Union receiver reaches a Method only where every member declares it.
			"Algebraic::isWholeNumber",
			"Algebraic::isZero",
			"Boolean::and",
			"Boolean::is",
			"Boolean::negate",
			"Boolean::or",
			// The quantified entry of `hasEntries`, whose Argument is a Function.
			"Dictionary::hasEntries",
			// Chains: `hasKey` asks a lookup's Optional, and `hasValue` asks the
			// List of values.
			"Dictionary::hasKey",
			// Its Argument is a Function of its own, not the caller's.
			"Dictionary::hasOnlyEntries",
			"Dictionary::hasValue",
			"Dictionary::is",
			"Dictionary::isEmpty",
			"Integer::is",
			"Integer::isEven",
			"Integer::isGreaterThan",
			"Integer::isLessThan",
			"Integer::isMultiple",
			"Integer::isPrime",
			"Integer::isWholeNumber",
			"List::contains",
			"List::ends",
			// Both entries are native, so there is no body to read.
			"List::hasDuplicates",
			"List::hasItems",
			"List::hasOnlyItems",
			"List::is",
			"List::isEmpty",
			// `isSorted` is native. `ends` and `starts` are chains that compare a
			// cut end of the receiver.
			"List::isSorted",
			"List::starts",
			"Number::is",
			"Optional::hasValue",
			"Optional::is",
			"Randomness::drawBoolean",
			"Rational::is",
			"Rational::isGreaterThan",
			"Rational::isLessThan",
			"Rational::isWholeNumber",
			"Record::is",
			// A chain asking whether the status lies between two bounds.
			"Response::isSuccessful",
			"Result::hasValue",
			"Result::is",
			"String::contains",
			"String::ends",
			// The character classes are native, each asking the host for one
			// Unicode class.
			"String::hasOnlyDigits",
			"String::hasOnlyLetters",
			"String::hasOnlyLettersOrDigits",
			"String::hasOnlyWhitespace",
			"String::is",
			"String::isEmpty",
			// A chain asking the length, on which the `Character` Type is
			// written. The literal evaluator holds a row for it.
			"String::isOneCharacter",
			"String::starts",
			"Transcendental::is",
			// Native: a form's sign is a primitive of the runtime.
			"Transcendental::isPositive",
			"Transcendental::isWholeNumber",
			"Transcendental::isZero",
			"protocol Comparable::isGreaterThan",
			"protocol Comparable::isLessThan",
			"protocol Equatable::is",
			"protocol Orderable::isBetween",
		])
	})

	// A Namespace holds exactly what its source declares, so the sources read
	// as the definition of the language. A synthetic `Boolean.es` gets none of
	// the shipped file's Methods.
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
