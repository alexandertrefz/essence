import type { common } from "@essence-lang/interfaces"

import {
	type GenericBindings,
	applyGenericBindings,
	findFulfillingMethod,
	refusePendingPredicate,
	resolveOverloadedMethodName,
} from "./types"

// The Namespace the derived equality of a Choice answers to. The Lexer reads
// `_` as a Symbol, so no source can spell it, and the Rewriter emits the runtime
// helper for it. The Enricher and the Rewriter both import these names.
export const derivedEquatableNamespaceName = "Choice_Equatable"

// The Namespace the derived printing of a Choice answers to.
export const derivedPrintableNamespaceName = "Choice_Printable"

// The Namespace the derived Case listing answers to. The Rewriter curries its
// helper with the tags of the Choice's Cases.
export const derivedEnumerableNamespaceName = "Choice_Enumerable"

// The Protocol a composite's members are asked about.
export const equatableProtocolName = "Equatable"

// The standard library Namespaces whose `is` asks only what a value is. See
// "Structural conformances" in DEVELOPMENT.md.
export const structurallyEquatableNamespaces = new Set([
	"String",
	"Integer",
	"Rational",
	"Boolean",
	"Number",
	"Record",
	derivedEquatableNamespaceName,
])

// The Namespaces whose `is` is structural exactly when what they hold is.
export const conditionallyStructuralNamespaces = new Set([
	"List",
	"Optional",
	"Result",
	derivedEquatableNamespaceName,
])

// The Namespaces whose `toString` answers what the structural walk renders.
// It differs from the equality list on purpose.
export const structurallyPrintableNamespaces = new Set([
	"String",
	"Integer",
	"Rational",
	"Algebraic",
	"Transcendental",
	"Boolean",
	"Number",
	"Record",
])

// The Namespaces whose printing is structural exactly when what they hold is.
export const conditionallyStructuralPrintableNamespaces = new Set([
	"List",
	"Dictionary",
])

// Whether a solved conformance is the structural one, which the Enricher
// asks before routing a member. A `parameter` source is never structural, since
// a caller decides it. See "Structural conformances" in DEVELOPMENT.md.
export function conformanceIsStructural(
	source: common.ConformanceSource,
	protocolName: string,
): boolean {
	if (source.kind === "parameter") {
		return false
	}

	let unconditional =
		protocolName === equatableProtocolName
			? structurallyEquatableNamespaces
			: structurallyPrintableNamespaces
	let conditional =
		protocolName === equatableProtocolName
			? conditionallyStructuralNamespaces
			: conditionallyStructuralPrintableNamespaces

	let named =
		source.conditions.length > 0
			? conditional.has(source.name)
			: unconditional.has(source.name)

	return (
		named &&
		source.conditions.every((condition) =>
			conformanceIsStructural(condition.source, protocolName),
		)
	)
}

// Each Protocol Method's emitted name, with its `__overload$N` suffix, mapped
// to the emitted name of the Namespace Method that fulfils it. A Simple
// requirement may be fulfilled by one Overload of a Namespace Method.
export type ConformanceMethodMap = Record<string, string>

// The memo and cycle-guard key of a Protocol and a Type. Keys are sorted, so
// structurally equal Types share a key. A Record's name is left out, since two
// Aliases of one shape are one Type.
export function conformanceKey(
	protocolName: string,
	type: common.Type,
): string {
	return `${protocolName}\u0000${stableSerialize(type)}`
}

// The display fields a Record may carry, which nothing structural reads.
const displayFields = new Set(["name", "alias"])

function stableSerialize(value: unknown): string {
	// A back-edge to an open object becomes `<cycle:N>`, N objects up, which
	// no quoted value can equal. Only open objects are held, so an object
	// shared sideways serialises in full each time.
	let visiting: Array<object> = []

	let serialize = (value: unknown): string => {
		if (value === null || typeof value !== "object") {
			return JSON.stringify(value) ?? "null"
		}

		let backEdge = visiting.indexOf(value)

		if (backEdge !== -1) {
			return `<cycle:${visiting.length - backEdge}>`
		}

		visiting.push(value)

		try {
			if (Array.isArray(value)) {
				return `[${value.map(serialize).join(",")}]`
			}

			// A refinement whose predicate is still pending must not become a
			// memo key, so this refuses it as `provenConjuncts` does.
			if (
				(value as Record<string, unknown>).type === "Refinement" &&
				(value as Record<string, unknown>).conjuncts === null
			) {
				refusePendingPredicate(value as common.RefinementType)
			}

			let spelled = (value as Record<string, unknown>).type === "Record"
			let entries = Object.entries(value as Record<string, unknown>)
				.filter(([key]) => !(spelled && displayFields.has(key)))
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, val]) => `${JSON.stringify(key)}:${serialize(val)}`)

			return `{${entries.join(",")}}`
		} finally {
			visiting.pop()
		}
	}

	return serialize(value)
}

// The Protocol that provided a body for a Method, or null for a requirement
// or a name the Protocol lacks. `Object.hasOwn`, since a plain index finds
// `Object.prototype.toString`.
export function providedMethodProtocol(
	protocol: common.ProtocolType,
	methodName: string,
): string | null {
	let provided = protocol.providedMethods

	return provided !== undefined && Object.hasOwn(provided, methodName)
		? provided[methodName]
		: null
}

// Whether a provided body answers the requirement of its name. A body is
// Simple, so it answers only a Simple requirement whose signature it fulfils
// with `Self` bound to the conformer's target.
export function providedBodyFulfils(
	methodName: string,
	requirement: common.MethodType | undefined,
	body: common.MethodType | undefined,
	target: common.Type,
): boolean {
	if (requirement?.type !== "SimpleMethod" || body?.type !== "SimpleMethod") {
		return false
	}

	let selfBindings: GenericBindings = new Map([["Self", target]])

	return (
		findFulfillingMethod(
			methodName,
			applyGenericBindings(
				requirement,
				selfBindings,
			) as common.SimpleMethodType,
			false,
			applyGenericBindings(body, selfBindings) as common.MethodType,
		) !== null
	)
}

// Whether a requirement fulfils another Protocol's entry that has a body,
// which a Namespace writing the requirement replaces. Only a Simple entry
// carries a body, so any other passes.
export function writtenRequirementFulfils(
	methodName: string,
	requirement: common.MethodType,
	entry: common.MethodType,
	target: common.Type,
): boolean {
	if (entry.type !== "SimpleMethod") {
		return true
	}

	let selfBindings: GenericBindings = new Map([["Self", target]])

	return (
		findFulfillingMethod(
			methodName,
			applyGenericBindings(
				entry,
				selfBindings,
			) as common.SimpleMethodType,
			false,
			applyGenericBindings(
				requirement,
				selfBindings,
			) as common.MethodType,
		) !== null
	)
}

// Whether a descendant Protocol's entry for an inherited name can stand in for
// the ancestor's in a witness. It must be of the same kind, so it sits under the
// same keys, and fulfil each signature.
export function restatementAccepts(
	methodName: string,
	inherited: common.MethodType,
	restated: common.MethodType,
): boolean {
	let signatures = (method: common.MethodType): Array<common.BaseFunction> =>
		method.type === "SimpleMethod" || method.type === "StaticMethod"
			? [method]
			: method.overloads
	let restatedSignatures = signatures(restated)

	return (
		inherited.type === restated.type &&
		signatures(inherited).length === restatedSignatures.length &&
		signatures(inherited).every(
			(signature, index) =>
				findFulfillingMethod(methodName, signature, false, {
					...restatedSignatures[index]!,
					type: "SimpleMethod",
				}) !== null,
		)
	)
}

// Every requirement of a Protocol a Namespace has not written, in declared
// order, for a Quick Fix that writes the stubs. A provided Method is not owed.
// `providerOf` has the same default as in `computeConformanceMethodMap`.
export function missingRequirements(
	protocol: common.ProtocolType,
	namespace: common.NamespaceType,
	providerOf: (methodName: string) => string | null = (methodName) =>
		providedMethodProtocol(protocol, methodName),
): Array<string> {
	let missing: Array<string> = []

	for (let methodName of Object.keys(protocol.methods)) {
		// `Object.hasOwn`, since a plain index finds `Object.prototype`.
		if (
			providerOf(methodName) !== null ||
			Object.hasOwn(namespace.methods, methodName)
		) {
			continue
		}

		missing.push(methodName)
	}

	return missing
}

export type ConformanceCheckResult =
	| {
			kind: "conforms"
			methodMap: ConformanceMethodMap
			// The provided Methods this conformer does not override, each
			// under the Protocol that wrote the body. They are in the witness,
			// emitted as the shared const curried with that Protocol's witness.
			providedMethods: ConformanceMethodMap
	  }
	| { kind: "missing"; methodName: string }
	| {
			kind: "mismatched"
			methodName: string
			// The Protocol whose provided body fulfils the requirement at
			// the conformer's target and not at the narrower binding.
			provider?: string
	  }
	// The fulfilling Method matches, but carries a bound of its own, such as
	// `<infer Item is Comparable>`, that no `where` clause supplies. So
	// `List is Comparable` needs `where Item is Comparable`.
	| {
			kind: "needs-condition"
			methodName: string
			genericName: string
			protocolName: string
	  }

// `assumptions` maps a Generic name to the Protocol a `where` clause lets the
// conformance assume. A fulfilling Method bounded beyond it answers
// `needs-condition`.
export function computeConformanceMethodMap(
	protocol: common.ProtocolType,
	namespace: common.NamespaceType,
	target: common.Type,
	assumptions: ReadonlyMap<string, string> = new Map(),
	// Whether conforming to one Protocol grants another, through Protocol
	// extension. A caller with a Scope hands the answer in.
	grants: (declared: string, wanted: string) => boolean = (
		declared,
		wanted,
	) => declared === wanted,
	// Which Protocol's body the conformer runs for a name, asked of all it
	// conforms to. A descendant's body is what a direct call reaches, so an
	// ancestor's witness names it too. A caller with a Scope hands it in.
	providerOf: (methodName: string) => string | null = (methodName) =>
		providedMethodProtocol(protocol, methodName),
): ConformanceCheckResult {
	let methodMap: ConformanceMethodMap = {}
	let providedMethods: ConformanceMethodMap = {}
	let selfBindings: GenericBindings = new Map([["Self", target]])

	for (let [methodName, requirement] of Object.entries(protocol.methods)) {
		let substituted = applyGenericBindings(
			requirement,
			selfBindings,
		) as common.MethodType

		// `Object.hasOwn`, since a plain index finds `Object.prototype`.
		let written = Object.hasOwn(namespace.methods, methodName)

		// A provided Method is not owed, but it is in the witness. An override
		// goes in the method map, held to the provided signature as a requirement
		// is, so a bounded call reaches it. Otherwise the provided const goes in.
		let providingProtocol = providerOf(methodName)

		if (providingProtocol !== null) {
			if (!written) {
				providedMethods[methodName] = providingProtocol

				continue
			}

			// A provided signature is always Simple, so the override is entered
			// under the one entry that fulfils it.
			let overriding = findFulfillingMethod(
				methodName,
				substituted as common.BaseFunction,
				false,
				namespace.methods[methodName],
			)

			if (overriding === null) {
				return { kind: "mismatched", methodName }
			}

			// Asked apart from the signature match: an override bounded beyond
			// the assumptions matches, and needs a `where` clause, not a new
			// signature.
			let bound = firstUnassumedBound(
				overriding.method,
				assumptions,
				grants,
			)

			if (bound !== null) {
				return { kind: "needs-condition", methodName, ...bound }
			}

			methodMap[methodName] = overriding.name

			continue
		}

		if (!written) {
			return { kind: "missing", methodName }
		}

		let implementation = namespace.methods[methodName]

		if (
			substituted.type === "SimpleMethod" ||
			substituted.type === "StaticMethod"
		) {
			let fulfilling = findFulfillingMethod(
				methodName,
				substituted,
				substituted.type === "StaticMethod",
				implementation,
			)

			if (fulfilling === null) {
				return { kind: "mismatched", methodName }
			}

			let bound = firstUnassumedBound(
				fulfilling.method,
				assumptions,
				grants,
			)

			if (bound !== null) {
				return { kind: "needs-condition", methodName, ...bound }
			}

			methodMap[methodName] = fulfilling.name
		} else {
			let requiresStatic = substituted.type === "OverloadedStaticMethod"

			for (let [index, overload] of substituted.overloads.entries()) {
				let fulfilling = findFulfillingMethod(
					methodName,
					overload,
					requiresStatic,
					implementation,
				)

				if (fulfilling === null) {
					return { kind: "mismatched", methodName }
				}

				let bound = firstUnassumedBound(
					fulfilling.method,
					assumptions,
					grants,
				)

				if (bound !== null) {
					return { kind: "needs-condition", methodName, ...bound }
				}

				methodMap[resolveOverloadedMethodName(methodName, index)] =
					fulfilling.name
			}
		}
	}

	return { kind: "conforms", methodMap, providedMethods }
}

// The first bound of the fulfilling Method the conformance may not assume, or
// null.
function firstUnassumedBound(
	method: common.BaseFunction,
	assumptions: ReadonlyMap<string, string>,
	grants: (declared: string, wanted: string) => boolean,
): { genericName: string; protocolName: string } | null {
	for (let generic of method.generics) {
		let assumed = assumptions.get(generic.name)

		if (
			generic.constraint != null &&
			(assumed === undefined || !grants(assumed, generic.constraint))
		) {
			return {
				genericName: generic.name,
				protocolName: generic.constraint,
			}
		}
	}

	return null
}
