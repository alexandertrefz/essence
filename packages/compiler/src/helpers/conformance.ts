import type { common } from "@essence-lang/interfaces"

import {
	type GenericBindings,
	applyGenericBindings,
	findFulfillingMethod,
	refusePendingPredicate,
	resolveOverloadedMethodName,
} from "./types"

// NOTE: The Namespace name the derived equality of a Choice answers to. It
// contains a `_`, which the Lexer reads as a Symbol rather than an Identifier
// character, so no Essence source can spell this name and it can never collide
// with a written Namespace. The Rewriter recognises it and emits the runtime
// helpers instead of a member read — there is no object anywhere with this name.
//
// NOTE: The fabricated names live here rather than in the Enricher that
// fabricates them, so that the Rewriter and the Enricher import one spelling:
// the Rewriter's brand and the Enricher's routing have to name the same
// Namespaces, and a name spelled twice is two places that can disagree.
// `resolvers.ts` re-exports the three Choice ones, so every site that imported
// them from there still does.
export const derivedEquatableNamespaceName = "Choice_Equatable"

// NOTE: The Namespace name the derived printing answers to, under the same rule
// as the one above: the `_` keeps it unspellable from Essence, and the Rewriter
// turns the one reference to it into the runtime helper.
export const derivedPrintableNamespaceName = "Choice_Printable"

// NOTE: The Namespace name the derived Case listing answers to, under the same
// rule as the two above: the `_` keeps it unspellable from Essence, and the
// Rewriter turns a reference to it into the runtime helper, curried with the
// tags the Choice's Cases carry.
export const derivedEnumerableNamespaceName = "Choice_Enumerable"

// NOTE: The Protocol a composite's members are asked about, named once because
// the routing rule reads it at several sites and a typo in any of them would
// silently route nothing.
export const equatableProtocolName = "Equatable"

// NOTE: The standard library's own Namespaces whose `Equatable::is` is
// STRUCTURAL — it asks what the value IS and nothing else, which is exactly what
// the Dictionary runtime's canonical key encoding stands in for. A String is its
// characters, an Integer is its number, a Rational is its reduced pair, a
// Boolean is one of two values, `Number` covers the three numeric kinds by the
// same rule, and a Record is its members compared by that same universal rule.
//
// The equality the language DERIVES for a Choice is on the list under the name
// the Enricher fabricates for it: it compares the tag and then the payload by
// the universal rule, and no Namespace wrote it. A Namespace that writes an
// `is` for its Choice REPLACES the derivation, so its witness arrives under the
// Namespace's own name and is not branded — unless the Namespace is one of the
// library's own, which is what the second list below is for. A conditional
// witness — a generic Choice's, or a Record that routes a member — is judged by
// that second list and never by this one.
//
// A refinement of one of those is not on the list and does not need to be: it
// declares no `is` of its own, so its conformance RESOLVES to the base
// Namespace's and arrives here under the base's name — `NonEmptyString` emits
// `String`'s witness. What a user Namespace writes never resolves to one of
// these, which is the whole point: `namespace Loose for NonEmptyString is
// Equatable` arrives as `Loose`, is not branded, and the runtime scans its slots
// through the witness instead of trusting an encoding that would call two of its
// keys distinct.
//
// NOTE: `Record` is on this list and not on the conditional one. The builtin
// Namespace's `is` compares every member through `anyIs` whatever its own
// Namespace writes, which is the structural rule; a Record that routes a member
// arrives with that member's witness as a condition, and the member's own `is`
// is by construction one that is not.
export const structurallyEquatableNamespaces = new Set([
	"String",
	"Integer",
	"Rational",
	"Boolean",
	"Number",
	"Record",
	derivedEquatableNamespaceName,
])

// NOTE: And the Namespaces whose `Equatable::is` is structural exactly when what
// they HOLD is compared structurally. `List::is` is the items compared pairwise
// through the item's own witness, so `List<ItemType> is Equatable where
// ItemType is Equatable` is structural if and only if the witness solving that
// `where` is — recursively, since a nested List's witness is decided by the same
// rule. A `List<NonEmptyString>` under a `namespace Loose for NonEmptyString is
// Equatable` is the case this has to refuse: `Loose` is not branded, so the List
// holding it is not either, and the runtime scans.
//
// A GENERIC CHOICE is the same rule met on the other kind of container, and
// there are three spellings of it here. `Optional` and `Result` WRITE their
// `is` in the standard library rather than deriving it — and each writes the
// derivation: the tag decides the Case, and the payload is compared through the
// Type Argument's own witness, which is `where ItemType is Equatable` solved.
// They are named for the same reason `String` and `Integer` are named above: the
// library's own `is` is a Method this Compiler knows the meaning of. The third
// is the DERIVED witness of a Choice a Program declares, which arrives under the
// fabricated name and is conditional whenever the Choice is generic OR one of
// its payload members routes — `boundChoiceIs` walks a descriptor that asks a
// witness at every such member and compares the rest by the universal rule.
//
// A Namespace a PROGRAM writes for its own Choice is still refused, because it
// arrives under its own name and is on neither list. So is `Dictionary`, whose
// `is` is structural under the same conditions but whose keys the runtime
// encoder declines outright: spelling a Dictionary would make `Dictionary.ts`
// and `keyEncoding.ts` a real cycle, and every `removeDuplicates` Program would
// carry the store. And so is a Record that ROUTES: it arrives as `Record` with a
// condition, on a member whose own `is` is by construction not the structural
// one, which is the whole reason it routes.
//
// The brand for such a Namespace is CONDITIONAL, and it is resolved where the
// condition witnesses are: `boundConformance` reads it off the method map, asks
// each of them, and only then puts it on the witness it builds. That is also
// the one place the answer CAN be settled — a generic Function's `List<T>`
// witness is built from a `T` witness forwarded in at the call, which the
// Compiler has no name for here.
export const conditionallyStructuralNamespaces = new Set([
	"List",
	"Optional",
	"Result",
	derivedEquatableNamespaceName,
])

// NOTE: The same question asked of PRINTING, and it is a DIFFERENT list — which
// is the half of this that is silent when it is wrong. Structural-for-printing
// means "the structural walk already renders a value of this Type exactly as its
// own `toString` answers", so a member on this list can be left to the walk and
// a member off it has to be routed through its Namespace.
//
// `Algebraic` and `Transcendental` are here and are NOT on the equality list
// above: the walk calls their `toString` outright, while their `is` is written
// in Essence over a comparison the key encoding can not stand in for. The
// asymmetry reads like a typo and is not one.
//
// A STRING is on the list even though the two readings differ — `"x"::toString()`
// is `x` and the walk writes `"x"`. Inside a composite the quoted form is what
// every reader already gets (`[ "a" ]`, `{ name = "a" }`), so routing a String
// member would take the quotes away rather than restore anything.
//
// Every written Namespace is off the list by not being on it, and so are the two
// that read a Case: `Choice_Printable` answers `Open` where the walk writes
// `Door#Open`, and `Optional`/`Result` answer `Value(3)` where it writes
// `Optional#Value(3)`.
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

// NOTE: And printing's conditional pair. A List renders as its items rendered,
// with the padding a Record's walk already passes (`[1, 2]`, which is what
// `List::toString` answers); a Dictionary renders as its entries, keys quoted.
// Either is structural exactly when what it holds is.
export const conditionallyStructuralPrintableNamespaces = new Set([
	"List",
	"Dictionary",
])

// NOTE: Whether a SOLVED conformance is the structural one — the question the
// Enricher asks of every declared member of a Record or a Case payload before
// deciding to route it, and the question the Rewriter's brand is decided by.
// One rule, read from one pair of lists, because a routed member and an encoded
// Dictionary key are the same claim seen from two sides.
//
// A `parameter` source is never structural: it is the enclosing Function's own
// witness, decided by a CALLER, and routing is the answer that is right whatever
// that caller hands in.
//
// NOTE: The two answers are one answer, and that is the point of one pair of
// lists: a member left UNROUTED is compared by `anyIs`, which IS the structural
// comparison a Dictionary's encoding stands in for, and a composite that routes
// ANYTHING carries a condition whose witness is by construction not branded — so
// the composite is not branded either and its keys scan through the very
// comparison that runs. Neither side can drift while both read this.
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
//
// NOTE: What a Record is CALLED is left out of it, because two Aliases of one
// shape are one Type here as everywhere: conforming is a question about the
// members, and a key that told `Standing` from the shape it stands for would
// ask it twice and answer the same — and would leave the cycle guard unable to
// recognise the question it is already inside.
export function conformanceKey(
	protocolName: string,
	type: common.Type,
): string {
	return `${protocolName}\u0000${stableSerialize(type)}`
}

// NOTE: The display fields a Record may carry, which nothing structural reads —
// see `common.RecordType`. Dropped by name rather than by rebuilding the Type,
// because the walk below is generic and a rebuild would have to enumerate every
// shape there is.
const displayFields = new Set(["name", "alias"])

function stableSerialize(value: unknown): string {
	// NOTE: The back-edge guard `resolveUnknownSlots` carries, and defence in
	// the same way: the Enricher refuses a Type declaration that names itself.
	// A walk that leads back to an object it is inside is answered with a bare
	// `<cycle:N>` marker naming how many objects up the walk it returns to: no
	// value can collide with it (a string of that spelling keeps its quotes),
	// and the distance keeps two Types that unfold differently from sharing a
	// memo key. Only the objects currently open are held, not everything seen:
	// a resolved Type is a DAG, and a shared object reached twice sideways has
	// to serialize fully both times, or two structurally identical Types built
	// with different sharing would stop producing the same key.
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
				refusePendingPredicate(value as common.RefinementType)
			}

			// NOTE: A Record's display fields are skipped here rather than at the
			// call above, so the key costs one comparison per object instead of
			// a second walk over the whole Type on a path conformance solving
			// takes for every Argument of every generic call.
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

// NOTE: Whether a provided body answers the requirement of its name. A body is
// Simple, so it answers a Simple requirement alone, and only where its signature
// fulfils the requirement's with `Self` bound to the conformer's target.
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

// NOTE: Whether a Method written as a requirement declares it fulfils another
// Protocol's entry with a body, which a Namespace writing it replaces and is held
// to. Only a Simple entry carries a body, so any other is not asked about.
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

// NOTE: Whether a descendant Protocol's entry for an inherited name can stand in
// for the ancestor's, as its witness does wherever the ancestor is asked for: of
// the same kind, so it sits under the same keys, and fulfilling each signature.
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

// NOTE: Every requirement of a Protocol a Namespace has not written, in the
// order the Protocol declares them. The check below answers with the FIRST one
// it meets, because one missing Method is enough to refuse a conformance — and
// a Quick Fix that writes the stubs needs all of them, so it asks here rather
// than the check growing a list it would throw away on every other path.
//
// A PROVIDED Method is not a requirement: the Protocol's own body answers it.
// `providerOf` is therefore asked the question `computeConformanceMethodMap`
// asks it, with the same default, so the two can not disagree about what a
// Namespace owes.
export function missingRequirements(
	protocol: common.ProtocolType,
	namespace: common.NamespaceType,
	providerOf: (methodName: string) => string | null = (methodName) =>
		providedMethodProtocol(protocol, methodName),
): Array<string> {
	let missing: Array<string> = []

	for (let methodName of Object.keys(protocol.methods)) {
		// NOTE: `Object.hasOwn`, never a plain index, for the reason spelled
		// out above.
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
			// NOTE: The Protocol's PROVIDED Methods this conformer does NOT
			// override, each under the Protocol that wrote the body. They are in
			// the witness like everything else — a bounded call must reach the
			// same Method a direct one does — but they are not Methods of the
			// Namespace, so they are kept apart from the map that names its
			// Methods and are emitted as the shared const, curried with a
			// witness of the Protocol that wrote it.
			providedMethods: ConformanceMethodMap
	  }
	| { kind: "missing"; methodName: string }
	| {
			kind: "mismatched"
			methodName: string
			// NOTE: The Protocol whose provided body fulfils the requirement at
			// the conformer's target and not at the narrower binding.
			provider?: string
	  }
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
		// takes a witness of its own Protocol as its trailing Argument.
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
