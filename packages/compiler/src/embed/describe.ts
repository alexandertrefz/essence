import type { common } from "@essence-lang/interfaces"

import { displayChoiceName } from "../helpers/describe"
import {
	resolveOverloadedMethodName,
	withoutRecordNames,
	withoutRecordNamesInSignature,
} from "../helpers/types"
import type { ExportSurface } from "../modules/link"
import { printSignature, printType } from "../printType"
import {
	type EmitTarget,
	emittedIdentity,
	escapeName,
	namespaceMemberName,
} from "../rewriter/index"

// The compile-time half of the boundary between Essence and JavaScript: Types
// described as plain JSON for the client's marshaller. See "Descriptors" in
// DEVELOPMENT.md.

// #region The Descriptor

// A Type as the marshaller needs it, JSON all the way down. `shown` is the Type
// as `printType` writes it, for refusals. Refinements and Aliases are unwrapped.
export type Descriptor =
	| { kind: "integer"; shown: string }
	| { kind: "rational"; shown: string }
	| { kind: "string"; shown: string }
	| { kind: "boolean"; shown: string }
	| { kind: "list"; of: Descriptor; shown: string }
	// A `Map`'s two slots, described independently.
	| { kind: "dictionary"; key: Descriptor; value: Descriptor; shown: string }
	| { kind: "record"; members: Members; shown: string }
	// `Optional`'s two Cases, which JavaScript spells `T | undefined`.
	| { kind: "optional"; of: Descriptor; shown: string }
	| { kind: "union"; arms: Array<Descriptor>; shown: string }
	// Work not yet run, and one run of it: a `Promise` of what it holds, allowed
	// only as an answer, as the marshaller decides.
	| { kind: "future"; of: Descriptor; shown: string }
	| { kind: "started"; of: Descriptor; shown: string }
	| CaseDescriptor
	| FunctionDescriptor
	// A Type with no mapping, carrying the sentence that says why.
	| { kind: "refused"; why: string; shown: string }

export type CaseDescriptor = {
	kind: "case"
	// The tag as the emitted JavaScript spells it, such as
	// `./Geometry.es#Shape#Circle`.
	tag: string
	// The Choice as declared, which a host's `$case` writes.
	choice: string
	name: string
	// Whether this is a Case of the builtin `Optional`, spelled by absence rather
	// than by a `$case`.
	optional: boolean
	// Whether every Case of this Choice has an empty payload, so each is spelled by
	// its bare name. All or nothing per Choice. See "Members and Cases" in
	// DEVELOPMENT.md.
	unitChoice: boolean
	payload: Members
	shown: string
}

// The members of a Record or a Case payload. `optional` absent means required.
// `fill` is a payload default's value, built at the boundary. See "Members and
// Cases" in DEVELOPMENT.md.
export type Members = Record<
	string,
	{ of: Descriptor; optional?: true; fill?: Fill }
>

// A payload default's literal as data. Numbers are decimal text, since JSON
// holds no bigint.
export type Fill =
	| { kind: "integer"; value: string }
	| { kind: "rational"; numerator: string; denominator: string }
	| { kind: "string"; value: string }
	| { kind: "boolean"; value: boolean }
	| { kind: "list"; items: Array<Fill> }
	| { kind: "record"; members: Record<string, Fill> }
	| { kind: "case"; tag: string; payload: Record<string, Fill> | null }

export type FunctionDescriptor = {
	kind: "function"
	// `optional` marks a Parameter with a default. Absent means required.
	parameters: Array<{
		label: string | null
		of: Descriptor
		optional?: true
	}>
	returns: Descriptor
	shown: string
}

// A whole Module: each export, what it is, and the name the bundle binds it
// under.
export type ModuleDescriptor = {
	exports: Record<string, ExportDescriptor>
}

export type ExportDescriptor =
	| { kind: "constant"; emitted: string; of: Descriptor }
	| { kind: "function"; emitted: string; of: FunctionDescriptor }
	// An Overload set binds a refusal, since a JavaScript value carries no Types to
	// pick an Overload by. Each Overload binds its own name.
	| { kind: "overloaded"; overloads: Array<OverloadDescriptor> }
	| ChoiceDescriptor
	| NamespaceDescriptor

// A Choice binds nothing, so the Descriptor offers one constructor per Case.
// Where a Namespace of that name is exported, they ride on it instead.
export type ChoiceDescriptor = {
	kind: "choice"
	name: string
	cases: Array<CaseDescriptor>
}

export type NamespaceDescriptor = {
	kind: "namespace"
	emitted: string
	// The Namespace as declared, which qualifies its members in an Error. An
	// export may use an Alias' name.
	name: string
	properties: Record<string, { emitted: string; of: Descriptor }>
	methods: Record<string, NamespaceMethod>
	// The constructors of a same-named Choice, beside the Methods.
	cases?: Array<CaseDescriptor>
}

export type NamespaceMethod =
	| { kind: "function"; emitted: string; of: FunctionDescriptor }
	| { kind: "overloaded"; overloads: Array<OverloadDescriptor> }

export type OverloadDescriptor = {
	// `from__overload$1`, the name the bundle binds this Overload under.
	name: string
	emitted: string
	// The line a refusal lists it as, rendered by `printSignature`.
	signature: string
	// The signature, for a declaration file to spell each Overload.
	of: FunctionDescriptor
}

// A Type the Module exports under its own name, or a Protocol with a null `of`.
// Kept apart from `ModuleDescriptor`, since nothing at run time reads one.
export type DeclaredType = {
	name: string
	of: Descriptor | null
}

// #endregion

// #region Describing

// What a Descriptor is spelled against. Case tags depend on the entry and the
// target, as in `emittedIdentity`.
export type DescribeContext = { entryPath: string; emit?: EmitTarget }

export function describe(
	type: common.Type,
	context: DescribeContext,
): Descriptor {
	return describeWith(type, context, new Set())
}

// One Function's signature, as a Namespace carries its Methods.
export function describeSignature(
	signature: common.BaseFunction,
	context: DescribeContext,
): FunctionDescriptor {
	return signatureWith(signature, context, new Set())
}

// `printing` holds the Types being walked, so one reaching itself is refused
// rather than followed.
function describeWith(
	type: common.Type,
	context: DescribeContext,
	printing: Set<common.Type>,
): Descriptor {
	// Without Record Alias names at every depth, since a JavaScript author reads
	// `shown`. See "Descriptors" in DEVELOPMENT.md.
	let shown = printType(withoutRecordNames(type))

	if (printing.has(type)) {
		return {
			kind: "refused",
			why: `${shown} is defined in terms of itself — there is no shape to build a value against.`,
			shown,
		}
	}

	printing.add(type)

	try {
		return describeBody(type, context, printing, shown)
	} finally {
		printing.delete(type)
	}
}

function describeBody(
	type: common.Type,
	context: DescribeContext,
	printing: Set<common.Type>,
	shown: string,
): Descriptor {
	switch (type.type) {
		case "Integer":
			return { kind: "integer", shown }
		case "Rational":
			return { kind: "rational", shown }
		case "String":
			return { kind: "string", shown }
		case "Boolean":
			return { kind: "boolean", shown }
		case "List":
			return {
				kind: "list",
				of: describeWith(type.itemType, context, printing),
				shown,
			}
		// A `Map`, whatever the key Type. The runtime builds and reads it through the
		// bridge. See "Shapes" in DEVELOPMENT.md.
		case "Dictionary":
			return {
				kind: "dictionary",
				key: describeWith(type.keyType, context, printing),
				value: describeWith(type.valueType, context, printing),
				shown,
			}
		case "Record":
			return {
				kind: "record",
				members: describeMembers(type.members, context, printing),
				shown,
			}
		case "Case":
			return describeCase(type, context, printing, shown)
		case "UnionType":
			return describeUnion(type, context, printing, shown)
		// Unwrapped: a refined value is built against its base, and an unapplied Alias
		// ends at a `GenericUse`.
		case "Refinement":
			return describeWith(type.base, context, printing)
		case "GenericAlias":
			return describeWith(type.aliasedType, context, printing)
		case "GenericUse":
			return {
				kind: "refused",
				why: `${shown} is a Type Parameter — there is no shape to build a value against until it is applied.`,
				shown,
			}
		case "Function":
		case "SimpleMethod":
		case "StaticMethod":
			return signatureWith(type, context, printing)
		// Refused, since neither has one signature to marshal a call against.
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return {
				kind: "refused",
				why: `a Function carries no Type of its own, and ${shown} declares more than one signature it could be — which of them to marshal a call against is undecidable.`,
				shown,
			}
		case "Namespace":
			return {
				kind: "refused",
				why: `${shown} is a Namespace rather than a value — there is nothing on the JavaScript side to build one from.`,
				shown,
			}
		// A `Promise` of what the work answers. Where one may stand is the marshaller's
		// rule.
		case "Future":
			return {
				kind: "future",
				of: describeWith(type.valueType, context, printing),
				shown,
			}
		case "Started":
			return {
				kind: "started",
				of: describeWith(type.valueType, context, printing),
				shown,
			}
		// Algebraic, Transcendental, and anything else without a mapping.
		default:
			return {
				kind: "refused",
				why: `${shown} can not be marshalled yet.`,
				shown,
			}
	}
}

// Only exactly the pair collapses, shown as the Union was. A Union with more
// arms decides arm by arm in written order.
function describeUnion(
	type: common.UnionType,
	context: DescribeContext,
	printing: Set<common.Type>,
	shown: string,
): Descriptor {
	let arms = type.types as Array<common.Type>

	if (arms.length === 2) {
		let value = arms.find((arm) => isOptionalCase(arm, "Value"))

		if (
			value !== undefined &&
			arms.some((arm) => isOptionalCase(arm, "Empty"))
		) {
			let item = (value as common.CaseType).members.item

			return {
				kind: "optional",
				of: describeWith(
					item ?? { type: "Unknown" },
					context,
					printing,
				),
				shown,
			}
		}
	}

	return {
		kind: "union",
		arms: arms.map((arm) => describeWith(arm, context, printing)),
		shown,
	}
}

function describeCase(
	type: common.CaseType,
	context: DescribeContext,
	printing: Set<common.Type>,
	shown: string,
): CaseDescriptor {
	return {
		kind: "case",
		// `emittedIdentity` is the Rewriter's rule, so tags agree by construction.
		tag: `${emittedIdentity(
			context.entryPath,
			type.choice,
			context.emit,
		)}#${type.name}`,
		choice: displayChoiceName(type.choice),
		name: type.name,
		// Compared by whole identity, so a Module's own `choice Optional` is ordinary.
		optional: type.choice === "Optional",
		// Stamped by the Enricher, since it is about the Case's siblings.
		unitChoice: type.unitChoice === true && type.choice !== "Optional",
		payload: withPayloadDefault(
			describeMembers(type.members, context, printing),
			type.payloadDefault,
			context,
		),
		shown,
	}
}

// The members a Case payload's default fills in, with their values. Nothing
// between a host's object and its Case marshals, so the boundary fills them.
function withPayloadDefault(
	members: Members,
	payloadDefault: common.CasePayloadDefault | undefined,
	context: DescribeContext,
): Members {
	if (payloadDefault?.values == null) {
		return members
	}

	let marked: Members = {}

	for (let [name, member] of Object.entries(members)) {
		let value = payloadDefault.values[name]
		let fill = value === undefined ? null : fillOf(value, context)

		marked[name] =
			fill === null
				? member
				: { ...member, optional: true as const, fill }
	}

	return marked
}

// A payload default's typed literal as data, or null for a default the
// Enricher refused.
function fillOf(
	node: common.typed.ExpressionNode,
	context: DescribeContext,
): Fill | null {
	switch (node.nodeType) {
		case "IntegerValue":
			return { kind: "integer", value: node.value }
		case "RationalValue":
			return {
				kind: "rational",
				numerator: node.numerator,
				denominator: node.denominator,
			}
		case "StringValue":
			return { kind: "string", value: node.value }
		case "BooleanValue":
			return { kind: "boolean", value: node.value }
		case "ListValue": {
			let items = node.values.map((value) => fillOf(value, context))

			return items.every((item) => item !== null)
				? { kind: "list", items: items as Array<Fill> }
				: null
		}
		case "RecordValue": {
			let members = fillMembers(node.members, context)

			return members === null ? null : { kind: "record", members }
		}
		case "CaseValue": {
			if (node.type.type !== "Case") {
				return null
			}

			let tag = `${emittedIdentity(
				context.entryPath,
				node.type.choice,
				context.emit,
			)}#${node.type.name}`

			if (node.value === null) {
				return { kind: "case", tag, payload: null }
			}

			if (node.value.nodeType !== "RecordValue") {
				return null
			}

			let payload = fillMembers(node.value.members, context)

			return payload === null ? null : { kind: "case", tag, payload }
		}
		default:
			return null
	}
}

function fillMembers(
	members: Record<string, common.typed.ExpressionNode>,
	context: DescribeContext,
): Record<string, Fill> | null {
	let filled: Record<string, Fill> = {}

	for (let [name, member] of Object.entries(members)) {
		let fill = fillOf(member, context)

		if (fill === null) {
			return null
		}

		filled[name] = fill
	}

	return filled
}

function describeMembers(
	members: Record<string, common.Type>,
	context: DescribeContext,
	printing: Set<common.Type>,
): Members {
	let described: Members = {}

	for (let [name, member] of Object.entries(members)) {
		described[name] = { of: describeWith(member, context, printing) }
	}

	return described
}

// The signature without its name, which is also `printType` of the Function
// Type. The marshaller adds the name a refused call was reached under.
function signatureWith(
	signature: common.BaseFunction,
	context: DescribeContext,
	printing: Set<common.Type>,
): FunctionDescriptor {
	return {
		kind: "function",
		parameters: signature.parameterTypes.map((parameter) => ({
			label: parameter.name,
			of: withOmittableMembers(
				describeWith(parameter.type, context, printing),
				parameter.defaultMembers,
			),
			...(parameter.hasDefault ? { optional: true as const } : {}),
		})),
		returns: describeWith(signature.returnType, context, printing),
		// Spelled by shape, as in `describeWith`.
		shown: printSignature(withoutRecordNamesInSignature(signature)),
	}
}

// The members a Record Parameter's default fills in, marked on that Parameter's
// Descriptor alone, since the callee fills them in.
function withOmittableMembers(
	descriptor: Descriptor,
	defaultMembers: ReadonlyArray<string> | undefined,
): Descriptor {
	if (defaultMembers === undefined || descriptor.kind !== "record") {
		return descriptor
	}

	let filled = new Set(defaultMembers)
	let members: Members = {}

	for (let [name, member] of Object.entries(descriptor.members)) {
		members[name] = filled.has(name)
			? { ...member, optional: true as const }
			: member
	}

	return { ...descriptor, members }
}

function isOptionalCase(type: common.Type, name: string): boolean {
	return (
		type.type === "Case" && type.choice === "Optional" && type.name === name
	)
}

// #endregion

// #region Modules

// Decided by each export's Type, not its `kind`. Every exported name is
// visited: a value from `surface.values`, and a Choice, which binds nothing, from
// `surface.types`. See "Modules" in DEVELOPMENT.md.
export function describeModule(
	surface: ExportSurface,
	entryPath: string,
	emit?: EmitTarget,
): ModuleDescriptor {
	let context: DescribeContext = { entryPath, emit }
	let exports: Record<string, ExportDescriptor> = {}

	for (let name of Object.keys(surface.kinds)) {
		let type = surface.values[name]
		let entry =
			type === undefined
				? undefined
				: describeValue(type, name, context, surface.exposed?.[name])
		let cases = choiceCasesOf(surface.types[name], name, context)

		if (cases !== null) {
			// One name binds one thing: constructors join a same-named Namespace, and lose
			// to any other value.
			if (entry === undefined) {
				exports[name] = { kind: "choice", name, cases }

				continue
			}

			if (entry.kind === "namespace") {
				exports[name] = { ...entry, cases }

				continue
			}
		}

		if (entry !== undefined) {
			exports[name] = entry
		}
	}

	return { exports }
}

function describeValue(
	type: common.Type,
	name: string,
	context: DescribeContext,
	exposed: Array<common.ExposedMethod> = [],
): ExportDescriptor {
	if (isOverloaded(type)) {
		return {
			kind: "overloaded",
			overloads: describeOverloads(type, name, "", escapeName, context),
		}
	}

	switch (type.type) {
		case "Function":
			return {
				kind: "function",
				emitted: escapeName(name),
				of: describeSignature(type, context),
			}
		case "Namespace":
			return describeNamespace(type, name, context, exposed)
		// A constant. The Validator refuses to export a `variable`.
		default:
			return {
				kind: "constant",
				emitted: escapeName(name),
				of: describe(type, context),
			}
	}
}

// The Cases of the Choice this name declares, or null. An Alias or an `as`
// name for a Choice gets no constructors.
function choiceCasesOf(
	type: common.Type | undefined,
	name: string,
	context: DescribeContext,
): Array<CaseDescriptor> | null {
	if (type === undefined) {
		return null
	}

	let described = describe(type, context)
	let arms = described.kind === "union" ? described.arms : [described]
	let cases: Array<CaseDescriptor> = []

	for (let arm of arms) {
		// `Optional`'s Cases are spelled by absence, so they get no constructors.
		if (arm.kind !== "case" || arm.optional || arm.choice !== name) {
			return null
		}

		cases.push(arm)
	}

	return cases.length === 0 ? null : cases
}

// The Types and Protocols the Module declares, in export order, for a
// declaration file.
export function describeTypes(
	surface: ExportSurface,
	entryPath: string,
	emit?: EmitTarget,
): Array<DeclaredType> {
	let context: DescribeContext = { entryPath, emit }
	let declared: Array<DeclaredType> = []

	for (let name of Object.keys(surface.kinds)) {
		if (surface.protocols[name] !== undefined) {
			declared.push({ name, of: null })

			continue
		}

		let type = surface.types[name]

		if (type !== undefined) {
			declared.push({ name, of: describe(type, context) })
		}
	}

	return declared
}

// Whether any position of the boundary, values or declared Types, is a
// Dictionary, so the bundle carries that door. See "Modules" in DEVELOPMENT.md.
export function carriesDictionary(
	module: ModuleDescriptor,
	types: ReadonlyArray<DeclaredType>,
): boolean {
	return boundaryReaches(
		module,
		types,
		(descriptor) => descriptor.kind === "dictionary",
	)
}

// Whether any position of the boundary is a Future or a Started.
export function carriesFuture(
	module: ModuleDescriptor,
	types: ReadonlyArray<DeclaredType>,
): boolean {
	return boundaryReaches(
		module,
		types,
		(descriptor) =>
			descriptor.kind === "future" || descriptor.kind === "started",
	)
}

// Whether any Descriptor of a Module's boundary is `wanted`.
function boundaryReaches(
	module: ModuleDescriptor,
	types: ReadonlyArray<DeclaredType>,
	wanted: (descriptor: Descriptor) => boolean,
): boolean {
	function reaching(descriptor: Descriptor): boolean {
		return reaches(descriptor, wanted)
	}

	for (let declared of types) {
		if (declared.of !== null && reaching(declared.of)) {
			return true
		}
	}

	for (let entry of Object.values(module.exports)) {
		switch (entry.kind) {
			case "constant":
			case "function":
				if (reaching(entry.of)) {
					return true
				}

				break
			case "overloaded":
				if (entry.overloads.some((overload) => reaching(overload.of))) {
					return true
				}

				break
			case "choice":
				if (entry.cases.some(reaching)) {
					return true
				}

				break
			case "namespace":
				if (
					Object.values(entry.properties).some((property) =>
						reaching(property.of),
					) ||
					Object.values(entry.methods).some((method) =>
						method.kind === "function"
							? reaching(method.of)
							: method.overloads.some((overload) =>
									reaching(overload.of),
								),
					) ||
					(entry.cases ?? []).some(reaching)
				) {
					return true
				}

				break
		}
	}

	return false
}

// A Descriptor is a tree, so no visited set. A wanted node stops the walk, and
// every other kind is walked through, Futures included.
function reaches(
	descriptor: Descriptor,
	wanted: (descriptor: Descriptor) => boolean,
): boolean {
	if (wanted(descriptor)) {
		return true
	}

	switch (descriptor.kind) {
		case "list":
		case "optional":
		case "future":
		case "started":
			return reaches(descriptor.of, wanted)
		case "dictionary":
			return (
				reaches(descriptor.key, wanted) ||
				reaches(descriptor.value, wanted)
			)
		case "record":
			return Object.values(descriptor.members).some((member) =>
				reaches(member.of, wanted),
			)
		case "case":
			return Object.values(descriptor.payload).some((member) =>
				reaches(member.of, wanted),
			)
		case "union":
			return descriptor.arms.some((arm) => reaches(arm, wanted))
		case "function":
			return (
				descriptor.parameters.some((parameter) =>
					reaches(parameter.of, wanted),
				) || reaches(descriptor.returns, wanted)
			)
		// Every kind is named, so a new one must be answered here.
		case "integer":
		case "rational":
		case "string":
		case "boolean":
		case "refused":
			return false
	}
}

// Members are keyed as written, since `memberKey` quotes what JavaScript can not
// spell. An instance Method's receiver is already its first Parameter. The
// provided Methods a host is offered are emitted beside the Namespace's own.
function describeNamespace(
	type: common.NamespaceType,
	name: string,
	context: DescribeContext,
	exposed: Array<common.ExposedMethod>,
): NamespaceDescriptor {
	let properties: NamespaceDescriptor["properties"] = {}
	let methods: Record<string, NamespaceMethod> = {}

	for (let [member, propertyType] of Object.entries(type.properties)) {
		properties[member] = {
			emitted: namespaceMemberName(member),
			of: describe(propertyType, context),
		}
	}

	for (let [member, methodType] of Object.entries(type.methods)) {
		methods[member] = isOverloaded(methodType)
			? {
					kind: "overloaded",
					overloads: describeOverloads(
						methodType,
						member,
						`${type.name}.`,
						namespaceMemberName,
						context,
					),
				}
			: {
					kind: "function",
					emitted: namespaceMemberName(member),
					of: describeSignature(methodType, context),
				}
	}

	for (let method of exposed) {
		methods[method.name] = {
			kind: "function",
			emitted: namespaceMemberName(method.name),
			of: describeSignature(method.type, context),
		}
	}

	return {
		kind: "namespace",
		emitted: escapeName(name),
		name: type.name,
		properties,
		methods,
	}
}

// Each Overload as `name__overload$N` with its printed line. A Namespace's is
// bound under the bare name and printed under the qualified one.
function describeOverloads(
	type: common.OverloadedMethodType | common.OverloadedStaticMethodType,
	name: string,
	qualifier: string,
	emit: (name: string) => string,
	context: DescribeContext,
): Array<OverloadDescriptor> {
	return type.overloads.map((overload, index) => {
		let overloadName = resolveOverloadedMethodName(name, index)

		return {
			name: overloadName,
			emitted: emit(overloadName),
			signature: printSignature(
				withoutRecordNamesInSignature(overload),
				`${qualifier}${overloadName}`,
			),
			of: describeSignature(overload, context),
		}
	})
}

function isOverloaded(
	type: common.Type,
): type is common.OverloadedMethodType | common.OverloadedStaticMethodType {
	return (
		type.type === "OverloadedMethod" ||
		type.type === "OverloadedStaticMethod"
	)
}

// #endregion
