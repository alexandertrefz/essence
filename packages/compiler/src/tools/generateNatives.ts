import { writeFileSync } from "node:fs"
import path from "node:path"

import type { common } from "@essence-lang/interfaces"
import { RUNTIME_DIRECTORY } from "@essence-lang/runtime"

import { loadStdlib, type Stdlib } from "../enricher/stdlib"
import { conformanceParameterName } from "../helpers/names"
import { resolveOverloadedMethodName } from "../helpers/types"

// Renders the loaded standard library into `natives.generated.ts`, the
// TypeScript contract that `tsc` holds the runtime's natives to. Regenerate
// with `bun run generate:natives`. See "The natives contract" in
// DEVELOPMENT.md.

// The module each runtime type is imported from.
const RUNTIME_TYPE_MODULES: Record<string, string> = {
	AlgebraicType: "./Algebraic",
	BooleanType: "./Boolean",
	DictionaryType: "./Dictionary",
	FutureType: "./Future",
	StartedType: "./Started",
	HttpMethodType: "./HttpMethod",
	RedirectsType: "./Redirects",
	HttpFailureType: "./HttpFailure",
	IntegerType: "./Integer",
	ListType: "./List",
	NumberType: "./Number",
	OrderingType: "./Ordering",
	LessType: "./Ordering",
	EqualType: "./Ordering",
	GreaterType: "./Ordering",
	SideType: "./Side",
	StartType: "./Side",
	EndType: "./Side",
	BothEndsType: "./Side",
	SortOrderType: "./SortOrder",
	AscendingType: "./SortOrder",
	DescendingType: "./SortOrder",
	NumberFormatType: "./NumberFormat",
	FractionType: "./NumberFormat",
	DecimalType: "./NumberFormat",
	PercentType: "./NumberFormat",
	ScientificType: "./NumberFormat",
	RoundingType: "./Rounding",
	NearestType: "./Rounding",
	NearestEvenType: "./Rounding",
	DownType: "./Rounding",
	UpType: "./Rounding",
	TowardZeroType: "./Rounding",
	CaseSensitivityType: "./CaseSensitivity",
	SensitiveType: "./CaseSensitivity",
	InsensitiveType: "./CaseSensitivity",
	NormalizationFormType: "./NormalizationForm",
	ComposedCanonicalType: "./NormalizationForm",
	DecomposedCanonicalType: "./NormalizationForm",
	ComposedCompatibilityType: "./NormalizationForm",
	DecomposedCompatibilityType: "./NormalizationForm",
	OptionalType: "./Optional",
	ValueType: "./Optional",
	EmptyType: "./Optional",
	RandomnessType: "./Randomness",
	RationalType: "./Rational",
	RecordType: "./Record",
	ResultType: "./Result",
	StepType: "./Step",
	ContinueType: "./Step",
	DoneType: "./Step",
	StreamType: "./Stream",
	OutputType: "./Stream",
	ErrorType: "./Stream",
	StringType: "./String",
	TranscendentalType: "./Transcendental",
	AnyType: "./type",
}

// Unions with a runtime alias, keyed on `UnionType.name`. `Irrational` has a
// name but no alias and appears in no signature.
const UNION_NAME_ALIASES: Record<string, string> = {
	Ordering: "OrderingType",
	Side: "SideType",
	SortOrder: "SortOrderType",
	NumberFormat: "NumberFormatType",
	Rounding: "RoundingType",
	NormalizationForm: "NormalizationFormType",
	CaseSensitivity: "CaseSensitivityType",
	Number: "NumberType",
	Stream: "StreamType",
	// `Http.send` takes the first two inside its Request and answers a
	// `#Failure` with the third.
	HttpMethod: "HttpMethodType",
	Redirects: "RedirectsType",
	HttpFailure: "HttpFailureType",
}

// Generic Choices, keyed on `UnionType.alias.name`, each rendered as its
// runtime alias applied to the mapped Type Arguments.
const GENERIC_UNION_ALIASES: Record<string, string> = {
	Step: "StepType",
	Optional: "OptionalType",
	Result: "ResultType",
}

// The Cases of generic Choices, for a Case that appears on its own in a
// signature.
const GENERIC_CASE_TYPES: Record<string, string> = {
	"Step#Continue": "ContinueType",
	"Step#Done": "DoneType",
	"Optional#Value": "ValueType",
	"Optional#Empty": "EmptyType",
}

// The runtime types of the builtin unit Choices' Cases.
const CASE_TYPES: Record<string, string> = {
	"Ordering#Less": "LessType",
	"Ordering#Equal": "EqualType",
	"Ordering#Greater": "GreaterType",
	"Side#Start": "StartType",
	"Side#End": "EndType",
	"Side#BothEnds": "BothEndsType",
	"SortOrder#Ascending": "AscendingType",
	"SortOrder#Descending": "DescendingType",
	"NumberFormat#Fraction": "FractionType",
	"NumberFormat#Decimal": "DecimalType",
	"NumberFormat#Percent": "PercentType",
	"NumberFormat#Scientific": "ScientificType",
	"Rounding#Nearest": "NearestType",
	"Rounding#NearestEven": "NearestEvenType",
	"Rounding#Down": "DownType",
	"Rounding#Up": "UpType",
	"Rounding#TowardZero": "TowardZeroType",
	"NormalizationForm#ComposedCanonical": "ComposedCanonicalType",
	"NormalizationForm#DecomposedCanonical": "DecomposedCanonicalType",
	"NormalizationForm#ComposedCompatibility": "ComposedCompatibilityType",
	"NormalizationForm#DecomposedCompatibility": "DecomposedCompatibilityType",
	"CaseSensitivity#Sensitive": "SensitiveType",
	"CaseSensitivity#Insensitive": "InsensitiveType",
	"Stream#Output": "OutputType",
	"Stream#Error": "ErrorType",
}

// Every runtime type a render referenced, for the imports, and every Protocol
// named as a bound, for the witness types.
type RenderContext = {
	used: Set<string>
	usedProtocols: Set<string>
}

// One `*Natives` type, the export names it forbids, and each native Method's
// arity.
type NativesSection = {
	text: string
	forbiddenKeys: Array<string>
	arities: Array<[string, number]>
}

function conformanceTypeName(protocolName: string): string {
	return `${protocolName}Conformance`
}

// A reserved word can not name a Parameter in TypeScript, so it becomes
// `argument<index>`. The comment on the entry keeps the Essence label.
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

// Maps an Essence Type to its runtime type. Throws, naming the site, on a Type
// it can not render, since a silent `any` would defeat the check.
function mapType(
	type: common.Type | common.GenericUse,
	ctx: RenderContext,
	where: string,
): string {
	switch (type.type) {
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
		case "Randomness":
			ctx.used.add("RandomnessType")
			return "RandomnessType"
		case "List":
			ctx.used.add("ListType")
			return `ListType<${mapType(type.itemType, ctx, where)}>`
		// A native answering a Future builds one at run time.
		case "Future":
			ctx.used.add("FutureType")
			return `FutureType<${mapType(type.valueType, ctx, where)}>`
		case "Started":
			ctx.used.add("StartedType")
			return `StartedType<${mapType(type.valueType, ctx, where)}>`
		case "Dictionary":
			ctx.used.add("DictionaryType")
			return `DictionaryType<${mapType(
				type.keyType,
				ctx,
				where,
			)}, ${mapType(type.valueType, ctx, where)}>`
		// A refinement erases to its base, which is all a native receives.
		case "Refinement":
			return mapType(type.base, ctx, where)
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

			// An applied generic Choice keeps its runtime alias, which a driver
			// reads.
			if (
				type.alias !== undefined &&
				GENERIC_UNION_ALIASES[type.alias.name] !== undefined
			) {
				let runtime = GENERIC_UNION_ALIASES[type.alias.name]!
				ctx.used.add(runtime)

				let args = type.alias.typeArguments
					.map((argument) => mapType(argument, ctx, where))
					.join(", ")

				return `${runtime}<${args}>`
			}

			// Any other Union, `Optional<Integer>` included, as the union of
			// its members.
			return type.types
				.map((memberType) => mapType(memberType, ctx, where))
				.join(" | ")
		}
		case "Case": {
			let key = `${type.choice}#${type.name}`

			// A generic Choice's Case applies its alias to its Type Arguments.
			if (
				type.typeArguments !== undefined &&
				GENERIC_CASE_TYPES[key] !== undefined
			) {
				let runtime = GENERIC_CASE_TYPES[key]!
				ctx.used.add(runtime)

				let args = type.typeArguments
					.map((argument) => mapType(argument, ctx, where))
					.join(", ")

				return `${runtime}<${args}>`
			}

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

// The arguments the calling convention passes a native: the declared
// Parameters, receiver included, and one witness per bounded Generic.
export function nativeArity(fn: common.BaseFunction): number {
	let generics = fn.generics ?? []

	return (
		fn.parameterTypes.length +
		generics.filter((generic) => generic.constraint != null).length
	)
}

// A signature as an arrow type, never method shorthand, so
// `strictFunctionTypes` checks it. Witness Parameters follow in Generic order.
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
				`${conformanceParameterName(generic.name)}: ${conformanceTypeName(generic.constraint)}<${generic.name}>`,
			)
		}
	}

	return `${genericParams}(${params.join(", ")}) => ${mapType(fn.returnType, ctx, where)}`
}

// An Essence spelling of a Type for an entry's comment. Cosmetic, so it never
// throws.
function describeEssenceType(type: common.Type | common.GenericUse): string {
	switch (type.type) {
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
		case "Randomness":
			return "Randomness"
		case "List":
			return `List<${describeEssenceType(type.itemType)}>`
		case "Future":
			return `Future<${describeEssenceType(type.valueType)}>`
		case "Started":
			return `Started<${describeEssenceType(type.valueType)}>`
		case "Dictionary":
			return `Dictionary<${describeEssenceType(
				type.keyType,
			)}, ${describeEssenceType(type.valueType)}>`
		// Named, as the Declaration wrote it.
		case "Refinement":
			return type.name
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

	// The receiver is left out, as the Essence source leaves it out.
	let declared = isStatic ? fn.parameterTypes : fn.parameterTypes.slice(1)

	let params = declared
		.map(
			(parameter) =>
				`${parameter.name ?? "_"}: ${describeEssenceType(parameter.type)}`,
		)
		.join(", ")

	return `${isStatic ? "static " : ""}${name}${genericPart}(${params}) -> ${describeEssenceType(fn.returnType)}`
}

// One `*Natives` entry: its comment and its property, tab-indented.
function nativeEntry(comment: string, key: string, rendered: string): string {
	return `\t// \`${comment}\`\n\t${key}: ${rendered}`
}

// A Namespace's `*Natives` type, Properties first, then Methods, each Overload
// under its mangled key. Also the Essence-bodied members' names and each native
// Method's arity.
function renderNamespace(
	namespace: common.NamespaceType,
	nativeBindings: Stdlib["nativeBindings"],
	ctx: RenderContext,
): NativesSection {
	let bindings = nativeBindings[namespace.name]
	let nativeEntries: Array<string> = []
	let bodiedKeys: Array<string> = []
	let arities: Array<[string, number]> = []

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
					arities.push([key, nativeArity(overload)])
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
				arities.push([name, nativeArity(method)])
			} else {
				bodiedKeys.push(name)
			}
		}
	}

	let text = `export type ${namespace.name}Natives = {\n${nativeEntries.join("\n")}\n}`

	return { text, forbiddenKeys: bodiedKeys, arities }
}

// The free Functions' `*Natives` type, rendered as a Namespace's static
// Methods. `loop` is the only one.
function renderFunctionsNatives(
	stdlib: Stdlib,
	ctx: RenderContext,
): NativesSection {
	let nativeEntries: Array<string> = []
	let bodiedKeys: Array<string> = []
	let arities: Array<[string, number]> = []

	for (let [name, flags] of Object.entries(stdlib.functionBindings)) {
		let member = stdlib.members[name]

		if (member === undefined) {
			continue
		}

		if (member.type === "OverloadedStaticMethod") {
			member.overloads.forEach((overload, index) => {
				let key = resolveOverloadedMethodName(name, index)
				let isNative = flags[index] ?? true

				if (isNative) {
					nativeEntries.push(
						nativeEntry(
							describeSignature(name, overload, true),
							key,
							renderArrow(
								overload,
								true,
								ctx,
								`functions.${key}`,
							),
						),
					)
					arities.push([key, nativeArity(overload)])
				} else {
					bodiedKeys.push(key)
				}
			})
		} else if (member.type === "Function") {
			let isNative = flags[0] ?? true

			if (isNative) {
				nativeEntries.push(
					nativeEntry(
						describeSignature(name, member, true),
						name,
						renderArrow(member, true, ctx, `functions.${name}`),
					),
				)
				arities.push([name, nativeArity(member)])
			} else {
				bodiedKeys.push(name)
			}
		}
	}

	let text = `export type FunctionsNatives = {\n${nativeEntries.join("\n")}\n}`

	return { text, forbiddenKeys: bodiedKeys, arities }
}

// The absence and arity assertions of one module, each left out where it
// would check nothing.
function renderExtraAssertions(
	exportPrefix: string,
	module: string,
	section: NativesSection,
): Array<string> {
	let lines: Array<string> = []

	if (section.forbiddenKeys.length > 0) {
		let forbidden = section.forbiddenKeys
			.map((key) => JSON.stringify(key))
			.join(" | ")

		lines.push(
			`export const $${exportPrefix}Absent: AssertNoEssenceExports<${module}, ${forbidden}> = true`,
		)
	}

	if (section.arities.length > 0) {
		// One entry per line, so a changed arity is a one-line diff.
		let arities = section.arities
			.map(([key, arity]) => `\t${key}: ${arity}`)
			.join("\n")

		lines.push(
			`export const $${exportPrefix}Arity: AssertArities<${module}, {\n${arities}\n}> = true`,
		)
	}

	return lines
}

// The free Functions' assertions, against `./functions`.
function renderFunctionsAssertion(section: NativesSection): string {
	let module = `typeof import("./functions")`

	let lines = [
		`declare const functionsModule: ${module}`,
		`export const $functions: FunctionsNatives = functionsModule`,
		...renderExtraAssertions("functions", module, section),
	]

	return lines.join("\n")
}

// The witness type for a bounded Type Parameter: the Protocol's surface with
// `Self` bound. A provided Method appears at the requirement's own arity.
// Throws on shapes it can not transcribe, which no Protocol has.
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

// A module's assertions. See "The assertions" in DEVELOPMENT.md.
function renderModuleAssertion(
	namespace: common.NamespaceType,
	section: NativesSection,
): string {
	let module = `typeof import("./${namespace.name}")`

	let lines = [
		`declare const ${namespace.name}Module: ${module}`,
		`export const $${namespace.name}: ${namespace.name}Natives = ${namespace.name}Module`,
		...renderExtraAssertions(namespace.name, module, section),
	]

	return lines.join("\n")
}

const HEADER = `// Generated by \`bun run generate:natives\`. Do not edit by hand.
//
// The calling convention every native binding in
// \`packages/standard-library/sources/*.es\` keeps, written as TypeScript so
// \`tsc\` can check it. Each \`*Natives\` type is the shape the runtime module of
// that Namespace must have. The \`$<Namespace>\` assertions check each runtime
// module against it. \`$<Namespace>Absent\` forbids a runtime export for a
// Method implemented in Essence, and \`$<Namespace>Arity\` pins how many
// Parameters each native takes. Nothing imports this file, so its only effect
// is the type error a drifted native raises under \`tsc\`. Regenerate after
// changing a standard library signature, since
// \`packages/compiler/src/tests/natives.spec.ts\` fails when this file drifts
// from the renderer.`

// Forbids a runtime export for a Method implemented in Essence. Built on
// `keyof`, which stays sound when `*Natives` is empty.
const ASSERT_HELPER = `type AssertNoEssenceExports<Module, Forbidden extends string> =
	Extract<keyof Module, Forbidden> extends never
		? true
		: ["a Method implemented in Essence must not be a runtime export", Extract<keyof Module, Forbidden>]`

// Pins each native's arity, which assignability can not check. A default or
// rest Parameter widens the arity, so it fails too.
const ASSERT_ARITY_HELPER = `type NativeArity<Member> = Member extends (...args: infer Arguments) => unknown
	? Arguments["length"]
	: never

type MismatchedArities<Module, Arities extends Record<string, number>> = {
	[Member in keyof Arities & keyof Module]: NativeArity<Module[Member]> extends Arities[Member]
		? never
		: Member
}[keyof Arities & keyof Module]

type AssertArities<Module, Arities extends Record<string, number>> =
	MismatchedArities<Module, Arities> extends never
		? true
		: ["a native must take exactly the Parameters its declaration does, with no default or rest Parameter", MismatchedArities<Module, Arities>]`

// Pure, so the drift spec can render without the file system. The output is
// deterministic, since every table is read in source order.
export function renderNativesModule(stdlib: Stdlib): string {
	let ctx: RenderContext = {
		used: new Set(),
		usedProtocols: new Set(),
	}

	// Rendered first, so `ctx` has recorded every type and Protocol it uses.
	let namespaces = stdlib.namespaces.map((namespace) => ({
		namespace,
		...renderNamespace(namespace, stdlib.nativeBindings, ctx),
	}))

	// Through the same `ctx`, so its types join the imports.
	let functions = renderFunctionsNatives(stdlib, ctx)

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

	let assertionSections = [
		...namespaces.map((entry) =>
			renderModuleAssertion(entry.namespace, entry),
		),
		renderFunctionsAssertion(functions),
	]

	let sections = [...namespaces, functions]

	let needsAssertHelper = sections.some(
		(entry) => entry.forbiddenKeys.length > 0,
	)
	let needsArityHelper = sections.some((entry) => entry.arities.length > 0)

	let parts = [HEADER, renderImports(ctx.used)]

	if (needsAssertHelper) {
		parts.push(ASSERT_HELPER)
	}

	if (needsArityHelper) {
		parts.push(ASSERT_ARITY_HELPER)
	}

	if (conformanceSections.length > 0) {
		parts.push(conformanceSections.join("\n\n"))
	}

	parts.push([...namespaceSections, functions.text].join("\n\n"))
	parts.push(assertionSections.join("\n\n"))

	return `${parts.join("\n\n")}\n`
}

const OUTPUT_PATH = path.join(RUNTIME_DIRECTORY, "natives.generated.ts")

if (import.meta.main) {
	writeFileSync(OUTPUT_PATH, renderNativesModule(loadStdlib()), "utf-8")
	console.log(`Wrote ${OUTPUT_PATH}`)
}
