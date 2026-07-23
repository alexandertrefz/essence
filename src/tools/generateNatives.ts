import { writeFileSync } from "node:fs"
import path from "node:path"

import { loadStdlib, type Stdlib } from "../enricher/stdlib"
import { resolveOverloadedMethodName } from "../helpers/index"
import type { common } from "../interfaces/index"

// NOTE: The renderer that turns the loaded standard library into a checked-in
// TypeScript contract for the runtime bindings — `src/rewriter/__internal/*.ts`.
// A body-less Method signature in `src/stdlib/*.es` declares a NATIVE bound by
// NAME ONLY to a runtime export; nothing between the Enricher's tables and the
// runtime module checks that the export has the RIGHT SHAPE. This module emits
// the shape as `import type`s and `type` aliases so that `tsc` can, in a later
// commit, enforce it. THIS commit emits only the aliases — no `declare const`,
// no assignment — so nothing is enforced yet and the file has zero runtime
// footprint. Regenerate with `bun run generate:natives`;
// `src/tests/natives.spec.ts` fails when this file drifts from the renderer.

// NOTE: The one place the Essence-Type → TypeScript-runtime-type mapping is
// written. Every primitive maps to its runtime shape; the Namespace → module
// path is the identity, so `NumberType` is imported from `./Number`, `LessType`
// from `./Ordering`, and so on.
const RUNTIME_TYPE_MODULES: Record<string, string> = {
	AlgebraicType: "./Algebraic",
	BooleanType: "./Boolean",
	IntegerType: "./Integer",
	ListType: "./List",
	NothingType: "./Nothing",
	NumberType: "./Number",
	OrderingType: "./Ordering",
	LessType: "./Ordering",
	EqualType: "./Ordering",
	GreaterType: "./Ordering",
	SideType: "./Side",
	StartType: "./Side",
	EndType: "./Side",
	BothEndsType: "./Side",
	RationalType: "./Rational",
	RecordType: "./Record",
	StringType: "./String",
	TranscendentalType: "./Transcendental",
	AnyType: "./type",
}

// NOTE: A UnionType with one of these names has a dedicated runtime alias —
// keyed on `UnionType.name`, which is display-only for assignability but IS the
// runtime representation here. `Irrational` also carries a name but no runtime
// alias and appears in no signature, so it is deliberately absent: it would
// fall through to the structural rendering below.
const UNION_NAME_ALIASES: Record<string, string> = {
	Ordering: "OrderingType",
	Side: "SideType",
	Number: "NumberType",
}

// NOTE: The runtime unit types of the builtin `Ordering` and `Side` Choices — the only
// Cases reachable in a signature, and then only inside the `Ordering` Union,
// which is mapped whole before its Cases are ever visited.
const CASE_TYPES: Record<string, string> = {
	"Ordering#Less": "LessType",
	"Ordering#Equal": "EqualType",
	"Ordering#Greater": "GreaterType",
	"Side#Start": "StartType",
	"Side#End": "EndType",
	"Side#BothEnds": "BothEndsType",
}

// NOTE: The mutable state threaded through one render — every runtime type name
// referenced (so the import block lists exactly what is used) and every Protocol
// named as a bound (so a conformance witness type is emitted for it).
type RenderContext = {
	used: Set<string>
	usedProtocols: Set<string>
}

function conformanceTypeName(protocolName: string): string {
	return `${protocolName}Conformance`
}

// NOTE: Parameter names are cosmetic in a Function Type — the runtime calling
// convention is positional — but TypeScript still rejects a reserved word in the
// slot (`with item: …` becomes `with: …`, a parse error). A reserved or absent
// label falls back to `argument${index}`, the same spelling an unlabelled
// Parameter already gets. The `// …` comment above the entry keeps the real
// Essence label.
const RESERVED_PARAMETER_NAMES = new Set([
	"with",
	"in",
	"for",
	"if",
	"else",
	"return",
	"function",
	"new",
	"delete",
	"void",
	"typeof",
	"instanceof",
	"this",
	"super",
	"class",
	"extends",
	"case",
	"default",
	"switch",
	"break",
	"continue",
	"do",
	"while",
	"throw",
	"try",
	"catch",
	"finally",
	"var",
	"let",
	"const",
	"enum",
	"export",
	"import",
	"yield",
	"await",
	"null",
	"true",
	"false",
])

function parameterName(name: string | null, index: number): string {
	if (name === null || RESERVED_PARAMETER_NAMES.has(name)) {
		return `argument${index}`
	}

	return name
}

// NOTE: Maps one Essence Type to its TypeScript runtime type. Throws, naming
// the site, on any variant it can not render — a silent `any` would defeat the
// whole check. `Unknown`, `Error`, an unapplied `GenericList`/`GenericAlias` and
// the like never occur in a resolved standard library signature; if one does,
// this is where it surfaces.
function mapType(
	type: common.Type | common.GenericUse,
	ctx: RenderContext,
	where: string,
): string {
	switch (type.type) {
		case "Nothing":
			ctx.used.add("NothingType")
			return "NothingType"
		case "Boolean":
			ctx.used.add("BooleanType")
			return "BooleanType"
		case "String":
			ctx.used.add("StringType")
			return "StringType"
		case "Integer":
			ctx.used.add("IntegerType")
			return "IntegerType"
		case "Rational":
			ctx.used.add("RationalType")
			return "RationalType"
		case "Algebraic":
			ctx.used.add("AlgebraicType")
			return "AlgebraicType"
		case "Transcendental":
			ctx.used.add("TranscendentalType")
			return "TranscendentalType"
		case "List":
			ctx.used.add("ListType")
			return `ListType<${mapType(type.itemType, ctx, where)}>`
		case "Record": {
			ctx.used.add("RecordType")

			let entries = Object.entries(type.members)

			if (entries.length === 0) {
				return "RecordType"
			}

			let members = entries
				.map(
					([name, memberType]) =>
						`${name}: ${mapType(memberType, ctx, where)}`,
				)
				.join("; ")

			return `RecordType & { ${members} }`
		}
		case "UnionType": {
			if (
				type.name !== undefined &&
				UNION_NAME_ALIASES[type.name] !== undefined
			) {
				let alias = UNION_NAME_ALIASES[type.name]!
				ctx.used.add(alias)
				return alias
			}

			// NOTE: Every other Union — an anonymous one (`Integer | Rational`) or
			// an aliased one (`Optional<Integer>` sets `alias`, not `name`) — is
			// rendered structurally as the union of its members.
			return type.types
				.map((memberType) => mapType(memberType, ctx, where))
				.join(" | ")
		}
		case "Case": {
			let key = `${type.choice}#${type.name}`
			let runtime = CASE_TYPES[key]

			if (runtime === undefined) {
				throw new Error(
					`${where}: no runtime type known for Case '${key}'`,
				)
			}

			ctx.used.add(runtime)
			return runtime
		}
		case "GenericUse":
			return type.name
		case "Function": {
			let params = type.parameterTypes.map(
				(parameter, index) =>
					`${parameterName(parameter.name, index)}: ${mapType(parameter.type, ctx, where)}`,
			)

			return `(${params.join(", ")}) => ${mapType(type.returnType, ctx, where)}`
		}
		default:
			throw new Error(
				`${where}: can not render Type variant '${type.type}'`,
			)
	}
}

// NOTE: One Method or Property signature as a TypeScript arrow type — NEVER
// method shorthand, so `strictFunctionTypes` applies sound contravariant
// parameter checking to it. The receiver leads a non-static entry (index 0,
// named `self`); each bounded Method Generic appends a trailing
// conformance-witness Parameter, in Generic declaration order, exactly as the
// runtime calling convention passes them.
function renderArrow(
	fn: common.BaseFunction,
	isStatic: boolean,
	ctx: RenderContext,
	where: string,
): string {
	let generics = fn.generics ?? []

	let genericParams = ""

	if (generics.length > 0) {
		ctx.used.add("AnyType")
		genericParams = `<${generics
			.map((generic) => `${generic.name} extends AnyType`)
			.join(", ")}>`
	}

	let params = fn.parameterTypes.map((parameter, index) => {
		let name =
			!isStatic && index === 0
				? "self"
				: parameterName(parameter.name, index)

		return `${name}: ${mapType(parameter.type, ctx, where)}`
	})

	for (let generic of generics) {
		if (generic.constraint != null) {
			ctx.usedProtocols.add(generic.constraint)
			params.push(
				`${generic.name}__conformance: ${conformanceTypeName(generic.constraint)}<${generic.name}>`,
			)
		}
	}

	return `${genericParams}(${params.join(", ")}) => ${mapType(fn.returnType, ctx, where)}`
}

// NOTE: A readable Essence spelling of a Type, for the `// …` comment above
// each entry — so an overload reorder shows up as a reviewable diff. Mirrors
// `describeType`, but expands Function Types and prints the bare Record as
// `Record`. Cosmetic, so it never throws.
function describeEssenceType(type: common.Type | common.GenericUse): string {
	switch (type.type) {
		case "Nothing":
			return "Nothing"
		case "Boolean":
			return "Boolean"
		case "String":
			return "String"
		case "Integer":
			return "Integer"
		case "Rational":
			return "Rational"
		case "Algebraic":
			return "Algebraic"
		case "Transcendental":
			return "Transcendental"
		case "List":
			return `List<${describeEssenceType(type.itemType)}>`
		case "Record": {
			let entries = Object.entries(type.members)

			if (entries.length === 0) {
				return "Record"
			}

			return `{ ${entries
				.map(
					([name, memberType]) =>
						`${name}: ${describeEssenceType(memberType)}`,
				)
				.join(", ")} }`
		}
		case "UnionType":
			if (type.name !== undefined) {
				return type.name
			}

			if (type.alias !== undefined) {
				return `${type.alias.name}<${type.alias.typeArguments
					.map(describeEssenceType)
					.join(", ")}>`
			}

			return type.types.map(describeEssenceType).join(" | ")
		case "Case":
			return `${type.choice}#${type.name}`
		case "GenericUse":
			return type.name
		case "Function": {
			let params = type.parameterTypes
				.map(
					(parameter) =>
						`${parameter.name ?? "_"}: ${describeEssenceType(parameter.type)}`,
				)
				.join(", ")

			return `(${params}) -> ${describeEssenceType(type.returnType)}`
		}
		default:
			return type.type
	}
}

function describeSignature(
	name: string,
	fn: common.BaseFunction,
	isStatic: boolean,
): string {
	let generics = fn.generics ?? []

	let genericPart =
		generics.length > 0
			? `<${generics
					.map((generic) =>
						generic.constraint != null
							? `${generic.name} is ${generic.constraint}`
							: generic.name,
					)
					.join(", ")}>`
			: ""

	// NOTE: The receiver is injected onto every non-static signature, so it is
	// dropped from the comment — the reader reads the Essence source, which does
	// not write it either.
	let declared = isStatic ? fn.parameterTypes : fn.parameterTypes.slice(1)

	let params = declared
		.map(
			(parameter) =>
				`${parameter.name ?? "_"}: ${describeEssenceType(parameter.type)}`,
		)
		.join(", ")

	return `${isStatic ? "static " : ""}${name}${genericPart}(${params}) -> ${describeEssenceType(fn.returnType)}`
}

// NOTE: One entry of a `*Natives` type — the comment line and the property with
// its arrow type, both already tab-indented for placement inside the object.
function nativeEntry(comment: string, key: string, rendered: string): string {
	return `\t// ${comment}\n\t${key}: ${rendered}`
}

// NOTE: A Namespace's `*Natives` type — every native entry (Properties first,
// in source order, then Methods, each Overload as its own mangled `__overload$N`
// key). Also returns the export names of the Essence-bodied members, so the
// assertion at the foot can forbid a runtime export for any of them. A fully
// Essence Namespace has an empty `*Natives` (`{}`) and every member forbidden.
function renderNamespace(
	namespace: common.NamespaceType,
	nativeBindings: Stdlib["nativeBindings"],
	ctx: RenderContext,
): { text: string; forbiddenKeys: Array<string> } {
	let bindings = nativeBindings[namespace.name]
	let nativeEntries: Array<string> = []
	let bodiedKeys: Array<string> = []

	for (let [name, propertyType] of Object.entries(namespace.properties)) {
		let isNative = bindings?.properties[name] ?? true

		if (isNative) {
			nativeEntries.push(
				nativeEntry(
					`${name}: ${describeEssenceType(propertyType)}`,
					name,
					mapType(propertyType, ctx, `${namespace.name}.${name}`),
				),
			)
		} else {
			bodiedKeys.push(name)
		}
	}

	for (let [name, method] of Object.entries(namespace.methods)) {
		let flags = bindings?.methods[name]
		let isStatic =
			method.type === "StaticMethod" ||
			method.type === "OverloadedStaticMethod"

		if (
			method.type === "OverloadedMethod" ||
			method.type === "OverloadedStaticMethod"
		) {
			method.overloads.forEach((overload, index) => {
				let key = resolveOverloadedMethodName(name, index)
				let isNative = flags?.[index] ?? true

				if (isNative) {
					nativeEntries.push(
						nativeEntry(
							describeSignature(name, overload, isStatic),
							key,
							renderArrow(
								overload,
								isStatic,
								ctx,
								`${namespace.name}.${key}`,
							),
						),
					)
				} else {
					bodiedKeys.push(key)
				}
			})
		} else {
			let isNative = flags?.[0] ?? true

			if (isNative) {
				nativeEntries.push(
					nativeEntry(
						describeSignature(name, method, isStatic),
						name,
						renderArrow(
							method,
							isStatic,
							ctx,
							`${namespace.name}.${name}`,
						),
					),
				)
			} else {
				bodiedKeys.push(name)
			}
		}
	}

	let text = `export type ${namespace.name}Natives = {\n${nativeEntries.join("\n")}\n}`

	return { text, forbiddenKeys: bodiedKeys }
}

// NOTE: The witness object a bounded Type Parameter is fulfilled with — the
// Protocol's Methods with `Self` bound to the Parameter. Throws on the shapes
// the witness can not transcribe (an overloaded Protocol Method, or a Protocol
// Method with its own bounded Generic); none occur in the current Protocols.
function renderConformanceType(
	protocol: common.ProtocolType,
	ctx: RenderContext,
): string {
	ctx.used.add("AnyType")

	let members = Object.entries(protocol.methods).map(([name, method]) => {
		if (
			method.type === "OverloadedMethod" ||
			method.type === "OverloadedStaticMethod"
		) {
			throw new Error(
				`Protocol '${protocol.name}' Method '${name}' is overloaded — can not render a conformance witness`,
			)
		}

		if (method.generics.some((generic) => generic.constraint != null)) {
			throw new Error(
				`Protocol '${protocol.name}' Method '${name}' carries a bounded Generic — can not render a conformance witness`,
			)
		}

		let isStatic = method.type === "StaticMethod"

		return `\t${name}: ${renderArrow(method, isStatic, ctx, `${protocol.name}.${name}`)}`
	})

	return `type ${conformanceTypeName(protocol.name)}<Self extends AnyType> = {\n${members.join("\n")}\n}`
}

function renderImports(used: Set<string>): string {
	let byModule = new Map<string, Array<string>>()

	for (let name of used) {
		let module = RUNTIME_TYPE_MODULES[name]

		if (module === undefined) {
			throw new Error(`No runtime module known for type '${name}'`)
		}

		let names = byModule.get(module)

		if (names === undefined) {
			names = []
			byModule.set(module, names)
		}

		names.push(name)
	}

	return [...byModule.keys()]
		.sort()
		.map(
			(module) =>
				`import type { ${byModule
					.get(module)!
					.sort()
					.join(", ")} } from "${module}"`,
		)
		.join("\n")
}

// NOTE: The POSITIVE direction of the contract — each runtime module must
// satisfy its `*Natives` type. `typeof import("./Boolean")` is the module's
// full export shape; assigning it to `BooleanNatives` checks module ⊇ contract,
// so a missing native (`Property 'x' is missing`) or a wrongly-typed one
// (wrong arity, receiver, conformance Parameter or Type) fails on that property,
// while EXTRA exports (`createBoolean`, `Record.entries`) are correctly
// permitted — a reference, unlike an object literal, is not excess-checked.
// Assigning to an empty `{}` (a fully Essence Namespace) is always fine, so the
// positive assertion never troubles a converted Namespace.
//
// When the Namespace has any Essence-implemented Method, a SECOND assertion
// forbids a runtime export for it via `AssertNoEssenceExports`. That helper is
// keyof-based rather than an intersection with a `?: never` type: an empty
// `{}` intersected with a weak `{ member?: never }` is itself weak, so the
// intersection form raised a FALSE `TS2559` ("has no properties in common") the
// moment `*Natives` went empty. The keyof form is non-weak and holds whether
// `*Natives` is empty or not.
//
// The `declare const` carries no runtime value; nothing imports this file, so
// the `export const`s are never evaluated. The Namespace → module path is the
// identity.
function renderModuleAssertion(
	namespace: common.NamespaceType,
	forbiddenKeys: Array<string>,
): string {
	let module = `typeof import("./${namespace.name}")`

	let lines = [
		`declare const ${namespace.name}Module: ${module}`,
		`export const $${namespace.name}: ${namespace.name}Natives = ${namespace.name}Module`,
	]

	if (forbiddenKeys.length > 0) {
		let forbidden = forbiddenKeys
			.map((key) => JSON.stringify(key))
			.join(" | ")

		lines.push(
			`export const $${namespace.name}Absent: AssertNoEssenceExports<${module}, ${forbidden}> = true`,
		)
	}

	return lines.join("\n")
}

const HEADER = `// GENERATED by \`bun run generate:natives\` — do not edit by hand.
//
// The calling convention every native binding in \`src/stdlib/*.es\` must keep,
// written as TypeScript so \`tsc\` can check it. Each \`*Natives\` type is the
// shape the runtime module of that Namespace must have. The \`$<Namespace>\`
// assertions at the foot check each runtime module against it; the paired
// \`$<Namespace>Absent\` assertion forbids a runtime export for any Method that is
// implemented in Essence. Nothing imports this file, so its only effect is the
// type error a drifted native raises under \`tsc\`. Regenerate after changing a
// standard library signature; \`src/tests/natives.spec.ts\` fails when it drifts
// from the renderer.`

// NOTE: The absence check. A Method implemented in Essence must NOT also be a
// runtime export — the leftover TypeScript would rot out of step with the
// Essence that replaced it. \`Forbidden\` is the union of those export names;
// when the Module exports none of them the type is \`true\` and the assignment
// \`= true\` holds, otherwise it is an error tuple naming the offending export.
// Keyed on \`keyof\` rather than an intersection with a \`?: never\` type, so it
// stays sound when a fully converted Namespace's \`*Natives\` is the empty \`{}\`
// — a \`{}\` intersected with a weak \`{ member?: never }\` is itself weak and
// would falsely reject a module that correctly lacks the member.
const ASSERT_HELPER = `type AssertNoEssenceExports<Module, Forbidden extends string> =
	Extract<keyof Module, Forbidden> extends never
		? true
		: ["a Method implemented in Essence must not be a runtime export", Extract<keyof Module, Forbidden>]`

// NOTE: Pure — takes the loaded standard library and returns the module text,
// so the drift test can render and compare without touching the file system.
// The Namespaces arrive already in `builtinMemberOrder` and every table is
// iterated in insertion (source) order, so the output is deterministic.
export function renderNativesModule(stdlib: Stdlib): string {
	let ctx: RenderContext = {
		used: new Set(),
		usedProtocols: new Set(),
	}

	// NOTE: Rendered before the imports and conformance types are assembled, so
	// that `ctx` records every runtime type and every bounded Protocol first.
	// Each render reports the export names of its Essence-bodied members, so the
	// assertion below forbids a runtime export for exactly those.
	let namespaces = stdlib.namespaces.map((namespace) => ({
		namespace,
		...renderNamespace(namespace, stdlib.nativeBindings, ctx),
	}))

	let namespaceSections = namespaces.map((entry) => entry.text)

	let conformanceSections = [...ctx.usedProtocols].sort().map((name) => {
		let protocol = stdlib.protocols[name]

		if (protocol === undefined) {
			throw new Error(
				`Protocol '${name}' is used as a bound but is not declared`,
			)
		}

		return renderConformanceType(protocol, ctx)
	})

	let assertionSections = namespaces.map((entry) =>
		renderModuleAssertion(entry.namespace, entry.forbiddenKeys),
	)

	let needsAssertHelper = namespaces.some(
		(entry) => entry.forbiddenKeys.length > 0,
	)

	let parts = [HEADER, renderImports(ctx.used)]

	if (needsAssertHelper) {
		parts.push(ASSERT_HELPER)
	}

	if (conformanceSections.length > 0) {
		parts.push(conformanceSections.join("\n\n"))
	}

	parts.push(namespaceSections.join("\n\n"))
	parts.push(assertionSections.join("\n\n"))

	return `${parts.join("\n\n")}\n`
}

const OUTPUT_PATH = path.resolve(
	import.meta.dirname,
	"../rewriter/__internal/natives.generated.ts",
)

if (import.meta.main) {
	writeFileSync(OUTPUT_PATH, renderNativesModule(loadStdlib()), "utf-8")
	console.log(`Wrote ${OUTPUT_PATH}`)
}
