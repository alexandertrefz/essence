import type { common } from "@essence-lang/interfaces"

import {
	displayChoiceName,
	resolveOverloadedMethodName,
} from "../helpers/index"
import type { ExportSurface } from "../modules/link"
import { printSignature, printType } from "../printType"
import {
	type EmitTarget,
	emittedIdentity,
	escapeName,
	namespaceMemberName,
} from "../rewriter/index"

// NOTE: The COMPILE-TIME half of the boundary between Essence and JavaScript —
// the only half that knows what a `common.Type` is. Everything here reads the
// Compiler's own vocabulary once and writes down what it found: a Descriptor,
// which is plain JSON, which an interpreter marshals by without ever meeting a
// Type. `@essence-lang/client`'s `marshal-runtime` is that interpreter, and this
// is the whole of what it has to be told.
//
// NOTE: It lives in the COMPILER rather than beside the interpreter because
// there are two things that write a Descriptor and neither may depend on the
// other: the client, which describes a Module it has just compiled in memory,
// and `esc build --embed`, which writes one beside a bundle for a host to load
// later. Both have the Compiler; only one of them has the client.
//
// The seam is where the two costs part. Resolving an Alias, unwrapping a
// refinement to its base, spelling a Case's tag the way the bundle spells it and
// printing a Type for an Error to name are all decisions that can be made ONCE,
// on a machine that has the Compiler; deciding whether the value in hand fits can
// only be made when the value is in hand. Before the seam the two were one
// function, so serving a marshalled Module out of a bundler would have meant
// shipping the Compiler to a browser to describe an `Optional<Integer>` — and the
// describing had been over since the build.
//
// NOTE: Nothing here decides anything the interpreter also decides. Where both
// halves would have to know a rule, the rule lives on ONE side and the other
// reads its answer: the tags are baked here because `emittedIdentity` is the
// Compiler's, and the wording of every refusal a Type can be named in is written
// here because `printType` is. A second copy of either is the only way the two
// could ever come to disagree.

// #region The Descriptor

// NOTE: A Type as the interpreter needs it, and NOTHING else — closed, and JSON
// all the way down, so that it survives being written beside a bundle, embedded
// in a generated Module or handed across a wire. Every node carries `shown`: the
// Type as `printType` writes it, which is what an Error names when a value does
// not fit. That string is the only reason a refusal reads the same on both sides
// of the seam.
//
// NOTE: There is no node for a refinement or for an Alias. Marshalling never had
// a rule for either — a refined Type is built against its base and an applied
// Alias is already substituted — so describing unwraps them rather than carrying
// a shape the interpreter would have to unwrap again.
export type Descriptor =
	| { kind: "integer"; shown: string }
	| { kind: "rational"; shown: string }
	| { kind: "string"; shown: string }
	| { kind: "boolean"; shown: string }
	| { kind: "list"; of: Descriptor; shown: string }
	| { kind: "record"; members: Record<string, Descriptor>; shown: string }
	// NOTE: The one Union with a JavaScript spelling of its own — `T |
	// undefined`. It reaches a Surface as the Union of `Optional`'s two Cases and
	// is collapsed here, because every rule about it is a rule about the pair.
	| { kind: "optional"; of: Descriptor; shown: string }
	| { kind: "union"; arms: Array<Descriptor>; shown: string }
	| CaseDescriptor
	| FunctionDescriptor
	// NOTE: A Type this boundary has no mapping for, carrying the sentence that
	// says why. Written where the Type could still be printed and read where a
	// value of it is finally met.
	| { kind: "refused"; why: string; shown: string }

export type CaseDescriptor = {
	kind: "case"
	// NOTE: The tag as the emitted JavaScript spells it —
	// `./Geometry.es#Shape#Circle`, relative to the entry inside a bundle and to
	// the root of a host's project inside one of those — which is the one
	// spelling a value built for that JavaScript may carry.
	tag: string
	// NOTE: The Choice as it was DECLARED, which is what a host writes: a `$case`
	// reads `Shape#Circle` or the bare `Circle`, never the Module path the tag
	// carries.
	choice: string
	name: string
	// NOTE: Whether this is the builtin `Optional`'s own Case — the Choice
	// spelled by ABSENCE rather than by a `$case`. Met on its own where a
	// `constant thing = #Value(3)` is inferred as the Case rather than as the
	// Union an annotation would have named.
	optional: boolean
	payload: Record<string, Descriptor>
	shown: string
}

export type FunctionDescriptor = {
	kind: "function"
	parameters: Array<{ label: string | null; of: Descriptor }>
	returns: Descriptor
	shown: string
}

// NOTE: A whole Module: every export, what it is bound AS, and what the bundle
// binds it under. Between this and the bundle there is nothing left for a host to
// have the Compiler for.
export type ModuleDescriptor = {
	exports: Record<string, ExportDescriptor>
}

export type ExportDescriptor =
	| { kind: "constant"; emitted: string; of: Descriptor }
	| { kind: "function"; emitted: string; of: FunctionDescriptor }
	// NOTE: The one export that binds to a REFUSAL rather than to a value —
	// which Overload a call means is decided by the Argument Types, and a
	// JavaScript value carries none. It has no `emitted` of its own: an Overload
	// set binds no name, each of its Overloads binds one.
	| { kind: "overloaded"; overloads: Array<OverloadDescriptor> }
	| NamespaceDescriptor

export type NamespaceDescriptor = {
	kind: "namespace"
	emitted: string
	// NOTE: The Namespace as it was declared, which is what qualifies its
	// members in an Error — `Point.shifted`. Not always the export name: a
	// Namespace can be exported under an Alias' name.
	name: string
	properties: Record<string, { emitted: string; of: Descriptor }>
	methods: Record<string, NamespaceMethod>
}

export type NamespaceMethod =
	| { kind: "function"; emitted: string; of: FunctionDescriptor }
	| { kind: "overloaded"; overloads: Array<OverloadDescriptor> }

export type OverloadDescriptor = {
	// NOTE: `from__overload$1` — the name the raw door binds this Overload
	// under, and the only name a host can actually call it by.
	name: string
	emitted: string
	// NOTE: The whole line a refusal lists it as, name and all. Rendered here
	// because `printSignature` is the Compiler's.
	signature: string
	// NOTE: The signature itself, which nothing at run time reads — an Overload
	// set binds to the refusal above rather than to a call. It is here because a
	// DECLARATION file has to spell each Overload out under the name the bundle
	// binds it as, and a Descriptor that could not answer that would send the
	// generated declarations back to the Compiler for the one shape they could
	// not describe.
	of: FunctionDescriptor
}

// NOTE: A Type the Module exports under a name of its own — everything the
// `type` and `choice` declarations put on an Export Surface, and the Protocols,
// which are a name and nothing else: a Namespace conforms to one and no value is
// ever of one, so there is no shape to describe and `of` is `null`.
//
// NOTE: Kept BESIDE a `ModuleDescriptor` rather than inside it. Nothing at run
// time reads a Type Alias — every use of one is already substituted where a value
// crosses — so carrying them in the Descriptor a wrapper embeds would ship a
// browser the one part of the boundary that never runs.
export type DeclaredType = {
	name: string
	of: Descriptor | null
}

// #endregion

// #region Describing

// NOTE: What a Descriptor is spelled against — the entry the Modules were
// emitted for, and the target they were emitted to. A Case tag is spelled
// relative to one of the two directories those decide between, so a Descriptor
// is only good beside the JavaScript it was described alongside; see
// `emittedIdentity`, which is the same rule and the only one.
export type DescribeContext = { entryPath: string; emit?: EmitTarget }

export function describe(
	type: common.Type,
	context: DescribeContext,
): Descriptor {
	return describeWith(type, context, new Set())
}

// NOTE: One Function's signature, which is no Type at all — a Namespace carries
// its Methods as `BaseFunction`s, and `wrapFunction` is handed one directly.
export function describeSignature(
	signature: common.BaseFunction,
	context: DescribeContext,
): FunctionDescriptor {
	return signatureWith(signature, context, new Set())
}

// NOTE: `printing` is the Types currently being walked, so that one reaching
// itself is answered rather than followed. Nothing can spell such a Type today —
// `recursive-type-declaration` refuses a declaration that names itself — so this
// is what keeps the day they land from being the day this overflows its stack
// instead of saying what it does not know.
function describeWith(
	type: common.Type,
	context: DescribeContext,
	printing: Set<common.Type>,
): Descriptor {
	let shown = printType(type)

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
		// NOTE: Unwrapped rather than described. A refinement's predicate is not
		// run at the boundary yet, so a value of one is built against its base;
		// and an APPLIED Alias is already substituted by the time it reaches an
		// Export Surface, so what is left to meet here is the unapplied form,
		// whose body still mentions its own Type Parameters. Walking into that
		// lands on a `GenericUse`, which says so.
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
		// NOTE: Callable and still described as a refusal, because neither has
		// ONE signature a call could be marshalled against — an Overload set
		// names several and a Namespace names none.
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
		case "Namespace":
			return {
				kind: "refused",
				why: `callbacks are not supported yet — ${shown} can not be built from a JavaScript value.`,
				shown,
			}
		// NOTE: The numeric tower above Rational, for now, and whatever else
		// arrives before its mapping does.
		default:
			return {
				kind: "refused",
				why: `${shown} can not be marshalled yet.`,
				shown,
			}
	}
}

// NOTE: EXACTLY the pair collapses. A Union that offers an `Optional` beside
// other arms — `Box | Optional<Integer>` — still decides arm by arm in the order
// it was written, and collapsing it would change which arm takes a value.
//
// NOTE: The collapsed node is shown as the UNION was — `Optional<Integer>`,
// which is what a reader wrote and what an Error has to name. The `#Value` arm
// on its own prints as `Optional#Value`, which names the bookkeeping instead.
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
		// NOTE: `emittedIdentity` is the Rewriter's own rule, so the tag a value
		// is built with here and the tag the emitted `match` reads are the same
		// string by construction rather than by agreement.
		tag: `${emittedIdentity(
			context.entryPath,
			type.choice,
			context.emit,
		)}#${type.name}`,
		choice: displayChoiceName(type.choice),
		name: type.name,
		// NOTE: The identity is compared whole rather than by its display name,
		// so a Module declaring a `choice Optional` of its own is a Choice like
		// any other.
		optional: type.choice === "Optional",
		payload: describeMembers(type.members, context, printing),
		shown,
	}
}

function describeMembers(
	members: Record<string, common.Type>,
	context: DescribeContext,
	printing: Set<common.Type>,
): Record<string, Descriptor> {
	let described: Record<string, Descriptor> = {}

	for (let [name, member] of Object.entries(members)) {
		described[name] = describeWith(member, context, printing)
	}

	return described
}

// NOTE: The signature WITHOUT its name — `printSignature` writes the name in
// front of what it prints, so a nameless print is the tail every spelling of it
// shares and the interpreter puts back whichever name the call it is refusing was
// reached under. It is also exactly `printType` of a Function Type, so one string
// names the signature in an Error about a call and in an Error about a value
// alike.
function signatureWith(
	signature: common.BaseFunction,
	context: DescribeContext,
	printing: Set<common.Type>,
): FunctionDescriptor {
	return {
		kind: "function",
		parameters: signature.parameterTypes.map((parameter) => ({
			label: parameter.name,
			of: describeWith(parameter.type, context, printing),
		})),
		returns: describeWith(signature.returnType, context, printing),
		shown: printSignature(signature),
	}
}

function isOptionalCase(type: common.Type, name: string): boolean {
	return (
		type.type === "Case" && type.choice === "Optional" && type.name === name
	)
}

// #endregion

// #region Modules

// NOTE: What a name is bound to is decided by the Export Surface's TYPE, never by
// its `kind`. A `type Rectangle` sharing its name with `namespace Rectangle` is
// exported under kind `type` and is a Namespace value, so describing by kind
// would promise a constant that is really a class.
//
// NOTE: `surface.values` is the list, not `surface.kinds`, for the same reason:
// `values` holds exactly the exports that have a runtime binding.
export function describeModule(
	surface: ExportSurface,
	entryPath: string,
	emit?: EmitTarget,
): ModuleDescriptor {
	let context: DescribeContext = { entryPath, emit }
	let exports: Record<string, ExportDescriptor> = {}

	for (let [name, type] of Object.entries(surface.values)) {
		if (isOverloaded(type)) {
			exports[name] = {
				kind: "overloaded",
				overloads: describeOverloads(
					type,
					name,
					"",
					escapeName,
					context,
				),
			}

			continue
		}

		switch (type.type) {
			case "Function":
				exports[name] = {
					kind: "function",
					emitted: escapeName(name),
					of: describeSignature(type, context),
				}

				break
			case "Namespace":
				exports[name] = describeNamespace(type, name, context)

				break
			// NOTE: Everything a value can be MADE of — a constant, and nothing
			// else, since the Validator refuses to export a `variable` and a
			// Method is only ever reached through the Namespace that holds it.
			default:
				exports[name] = {
					kind: "constant",
					emitted: escapeName(name),
					of: describe(type, context),
				}
		}
	}

	return { exports }
}

// NOTE: The Types the Module declares, in the order it exported them — what a
// declaration file names its shapes after, and the only part of a Module a
// generated one can not read off the exports. A Protocol is described as a name
// alone: a Namespace conforms to one, and no value is ever of one.
//
// NOTE: `surface.kinds` is the list here, rather than `surface.types`, because
// the ORDER is the order the export block was written in — which is the order a
// reader of the source already knows the Module by. A name with no Type behind it
// is a value's, and is left to `describeModule`.
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

// NOTE: A Namespace's members are keyed by the name as it was WRITTEN —
// `memberKey` quotes what JavaScript can not spell rather than escaping it, so a
// Method named `ok?` is the property `"ok?"`. `escapeName` belongs to the top
// level alone and would look for a member nothing binds. The one exception is
// `namespaceMemberName`'s own: a class refuses a static member named `prototype`
// or `constructor`, so the Rewriter mangles those two.
//
// NOTE: An INSTANCE Method keeps the receiver it is emitted with as its first
// Parameter — the Export Surface already carries it, typed as the Namespace's
// target — so nothing here has to add it, and a caller passes it where there is
// no `::` to put it before the name.
function describeNamespace(
	type: common.NamespaceType,
	name: string,
	context: DescribeContext,
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

	return {
		kind: "namespace",
		emitted: escapeName(name),
		name: type.name,
		properties,
		methods,
	}
}

// NOTE: An Overload set binds no name of its own — each Overload is its own
// `name__overload$N` — so what is described is the list of those, each with the
// line a refusal spells it out as. The name is bound to that refusal rather than
// left off: reaching it says what is wrong and where the Overloads are, where a
// missing name would only say that something the Module exports is not there.
//
// NOTE: A Namespace's Overload is BOUND under the bare Method name and NAMED
// under the qualified one — `Point.from__overload$1` is what a reader has to
// find, and `from__overload$1` is what the class actually holds. So the
// qualifier goes into the printed line and nowhere else.
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
			signature: printSignature(overload, `${qualifier}${overloadName}`),
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
