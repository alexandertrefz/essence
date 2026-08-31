import type { common } from "@essence-lang/interfaces"

import {
	type GenericBindings,
	applyGenericBindings,
	findFulfillingMethod,
	resolveOverloadedMethodName,
} from "./types"

// NOTE: Maps each Protocol Method's *emitted* name (with `__overload$N`
// suffixes for overloaded Protocol Methods) to the fulfilling Namespace
// Method's emitted name. This is the single source of truth for both
// conformance checking and conformance-value codegen — bound Method bodies
// compile against the Protocol's names, the map translates them to whatever
// the Namespace actually exports (a Simple requirement may well be fulfilled
// by one overload of an Overloaded Namespace Method).
export type ConformanceMethodMap = Record<string, string>

// NOTE: A deterministic key for a (Protocol, Type) pair, used to memoise and
// cycle-guard conformance solving. The Type is serialised with object keys
// sorted, so two structurally identical Types always produce the same key
// regardless of the order their properties were built in. The NUL separator
// keeps the Protocol name from colliding with the serialised Type.
export function conformanceKey(
	protocolName: string,
	type: common.Type,
): string {
	return `${protocolName}\u0000${stableSerialize(type)}`
}

function stableSerialize(value: unknown): string {
	// NOTE: A Choice's payload may name the Choice, so the walk can lead back
	// to an object it is inside — the same back-edge `resolveUnknownSlots`
	// guards for. Meeting one is answered with a bare `<cycle:N>` marker naming
	// how many objects up the walk it returns to: no value can collide with it
	// (a string of that spelling keeps its quotes), and the distance keeps two
	// Types that unfold differently from sharing a memo key. Only the objects
	// currently OPEN are held, not everything seen: a resolved Type is a DAG,
	// and a shared object reached twice sideways has to serialize fully both
	// times, or two structurally identical Types built with different sharing
	// would stop producing the same key.
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

			// NOTE: A generic walker does not go through `provenConjuncts`, so it keeps
			// the same promise by hand: a refinement whose predicate has not resolved
			// yet must not become anybody's memo key, because the key would keep naming
			// the empty predicate after the conjuncts were written in. The throw is the
			// hoisting rounds' "not this round", exactly as it is at every other reader.
			if (
				(value as Record<string, unknown>).type === "Refinement" &&
				(value as Record<string, unknown>).conjuncts === null
			) {
				throw new Error(
					`Internal Compiler Error: the predicate of refinement '${String(
						(value as Record<string, unknown>).name,
					)}' was read before it resolved`,
				)
			}

			let entries = Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, val]) => `${JSON.stringify(key)}:${serialize(val)}`)

			return `{${entries.join(",")}}`
		} finally {
			visiting.pop()
		}
	}

	return serialize(value)
}

// NOTE: The Protocol that PROVIDED a Method a body for, or null where the name
// is a requirement — or no Method of the Protocol at all.
//
// `Object.hasOwn`, never a plain index: a Method named `toString` finds
// `Object.prototype.toString` on the record and reads as provided by a Protocol
// called "function toString() { [native code] }". That is not a hypothetical —
// `Printable.toString` is the standard library's, and a plain index quietly
// stopped requiring it of every conformer.
export function providedMethodProtocol(
	protocol: common.ProtocolType,
	methodName: string,
): string | null {
	let provided = protocol.providedMethods

	return provided !== undefined && Object.hasOwn(provided, methodName)
		? provided[methodName]
		: null
}

export type ConformanceCheckResult =
	| {
			kind: "conforms"
			methodMap: ConformanceMethodMap
			// NOTE: The Protocol's PROVIDED Methods this conformer does NOT
			// override, each under the Protocol that wrote the body. They are in
			// the witness like everything else — a bounded call must reach the
			// same Method a direct one does — but they are not Methods of the
			// Namespace, so they are kept apart from the map that names its
			// Methods and are emitted as the shared const, curried with the
			// finished witness.
			providedMethods: ConformanceMethodMap
	  }
	| { kind: "missing"; methodName: string }
	| { kind: "mismatched"; methodName: string }
	// NOTE: The fulfilling Method matches the Protocol's signature, but carries
	// a Protocol bound of its own (`<infer Item is Comparable>`) that the
	// conformance has not been told to assume. The conformance is sound only
	// *conditionally* — under a `where` clause supplying that bound — so it can
	// not be granted unconditionally. This is what keeps a generic Namespace's
	// blanket conformance honest: `List is Comparable` needs `where Item is
	// Comparable`, and until it says so, this reports which bound is missing.
	| {
			kind: "needs-condition"
			methodName: string
			genericName: string
			protocolName: string
	  }

// NOTE: `assumptions` maps a Generic name to the Protocol the conformance is
// allowed to assume it satisfies (from a `where` clause). A fulfilling Method
// whose own Generic carries a bound absent from this map can not fulfill
// unconditionally — see the `needs-condition` result.
export function computeConformanceMethodMap(
	protocol: common.ProtocolType,
	namespace: common.NamespaceType,
	target: common.Type,
	assumptions: ReadonlyMap<string, string> = new Map(),
	// NOTE: Whether conforming to one Protocol grants conformance to another —
	// a Protocol extension. This module knows nothing about a Scope, so the one
	// caller that does hands the answer in; the default is the plain equality
	// every caller without a Scope means.
	grants: (declared: string, wanted: string) => boolean = (
		declared,
		wanted,
	) => declared === wanted,
	// NOTE: WHOSE body this conformer runs for a name — asked of everything the
	// conformer conforms to, not of the Protocol this witness is being solved
	// for. A DESCENDANT that re-provided an ancestor's Method is the one a
	// direct call reaches, so the witness an ANCESTOR bound is handed has to
	// name it too; asking the ancestor alone made the same expression answer
	// differently depending on which bound it was written under. It also
	// answers for a body a descendant wrote where the ancestor only REQUIRED
	// one: the conformer owes nothing, because the descendant provides it.
	//
	// The default is the plain question a caller without a Scope means. This
	// module can not walk the extension graph, so the callers that can hand
	// the answer in, exactly as they hand `grants` in.
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

		// NOTE: Object.hasOwn, not a plain index — a Method named `toString`
		// would otherwise find Object.prototype.toString on the record.
		let written = Object.hasOwn(namespace.methods, methodName)

		// NOTE: A PROVIDED Method is not owed — a Namespace that writes none
		// still answers it, because the Protocol's body does — but it IS in the
		// witness, under one of two entries.
		//
		// A Namespace that writes one has REPLACED it, whole, and the
		// replacement goes in the method map exactly as a requirement's
		// fulfiller does: the witness is what a bounded call reads, so an
		// override that stayed out of it would make `t::isLessThan(x)` inside a
		// `<T is Orderable>` answer differently from the same call on the
		// Namespace's own Type. It is held to the provided signature by exactly
		// the check a requirement gets — hence the same `mismatched` answer.
		//
		// A Namespace that writes none is entered as the PROVIDED const, which
		// takes the witness it is read off as its own trailing Argument.
		let providingProtocol = providerOf(methodName)

		if (providingProtocol !== null) {
			if (!written) {
				providedMethods[methodName] = providingProtocol

				continue
			}

			// NOTE: A provided signature is always Simple — a body on an
			// `overload` entry is refused at the declaration — so the override
			// is entered under the one entry that fulfills it.
			let overriding = findFulfillingMethod(
				methodName,
				substituted as common.BaseFunction,
				false,
				namespace.methods[methodName],
			)

			if (overriding === null) {
				return { kind: "mismatched", methodName }
			}

			// NOTE: Asked separately from the match above, and in the
			// requirement path's order, because the two are different news: an
			// override whose own Generic carries a bound the conformance was
			// not told to assume MATCHES the signature, and needs a `where`
			// clause rather than a different signature. Collapsing them told
			// the writer the signature was wrong when it was not.
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

// NOTE: The first bound the fulfilling Method carries that the conformance was
// not told to assume — `null` when every bound is covered (or there are none).
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
