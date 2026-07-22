import type { common, lexer } from "../interfaces/index"

function editDistance(left: string, right: string): number {
	let previous = Array.from({ length: right.length + 1 }, (_, i) => i)

	for (let i = 1; i <= left.length; i++) {
		let current = [i]

		for (let j = 1; j <= right.length; j++) {
			let substitution =
				previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)

			current.push(
				Math.min(previous[j] + 1, current[j - 1] + 1, substitution),
			)
		}

		previous = current
	}

	return previous[right.length]
}

// NOTE: A suggestion is only offered when it is close enough to be plausible —
// proposing an unrelated flag is worse than proposing nothing.
export function closestMatch(
	input: string,
	candidates: Array<string>,
): string | null {
	let best: { name: string; distance: number } | null = null

	for (let candidate of candidates) {
		let distance = editDistance(input, candidate)

		if (best === null || distance < best.distance) {
			best = { name: candidate, distance }
		}
	}

	if (best === null) {
		return null
	}

	let threshold = Math.max(2, Math.floor(input.length / 3))

	// NOTE: A candidate must also share more with the input than it differs
	// from it. Without that, every short name is within the threshold of
	// every other short name, and `point.z` gets told it meant `point.x`.
	return best.distance <= threshold && best.distance < input.length
		? best.name
		: null
}

// NOTE: A compact, one-line description of a Type for Diagnostics — the
// spelling a reader would recognise from their own source, not the internal
// Type tag. `printType` in the Language Server is its Hover-oriented sibling;
// this one is what every Diagnostic message names a Type with.
export function describeType(type: common.Type): string {
	switch (type.type) {
		case "UnionType":
			if (type.name !== undefined) {
				return type.name
			}

			if (type.alias !== undefined) {
				return `${type.alias.name}<${type.alias.typeArguments
					.map(describeType)
					.join(", ")}>`
			}

			return type.types.map(describeType).join(" | ")
		case "Case":
			return `${type.choice}#${type.name}`
		case "List":
			return `List<${describeType(type.itemType)}>`
		case "GenericList":
			return "List"
		case "Record":
			return `{ ${Object.entries(type.members)
				.map(
					([memberName, memberType]) =>
						`${memberName}: ${describeType(memberType)}`,
				)
				.join(", ")} }`
		case "Function":
		case "SimpleMethod":
		case "StaticMethod":
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return "Function"
		case "Namespace":
			return `Namespace '${type.name}'`
		case "GenericUse":
		case "GenericAlias":
			return type.name
		default:
			return type.type
	}
}

// NOTE: A Parameter is identified by its label where it has one, and by its
// place in the signature where it does not — `_ value: Integer` is written
// without a label on purpose, and inventing one for the Diagnostic would name
// something the reader can not find in the source.
export function describeParameter(
	parameter: common.Parameter | undefined,
	index: number,
): string {
	return parameter?.name != null
		? `Parameter '${parameter.name}'`
		: `Parameter ${index + 1}`
}

export function describeSignature(
	parameterTypes: Array<common.Parameter>,
): string {
	if (parameterTypes.length === 0) {
		return "takes no Arguments"
	}

	return `takes ${countOf(parameterTypes.length, "Argument")}: ${parameterTypes
		.map(
			(parameter, index) =>
				`${describeParameter(parameter, index)} is ${describeType(parameter.type)}`,
		)
		.join(", ")}`
}

// NOTE: For Diagnostics — "1 Argument", not "1 Arguments".
export function countOf(count: number, singular: string): string {
	return count === 1 ? `1 ${singular}` : `${count} ${singular}s`
}

// NOTE: For Diagnostics — "this is an Integer", not "this is a Integer".
// Type names are the only thing this is ever applied to, and they are always
// spelled out, so the vowel rule needs no exceptions.
export function withArticle(description: string): string {
	return /^[AEIOU]/i.test(description)
		? `an ${description}`
		: `a ${description}`
}

export function stripPositionFromArray(
	tokens: Array<lexer.Token | undefined>,
): Array<lexer.SimpleToken | undefined> {
	return tokens.map((value) => stripPosition(value))
}

export function stripPosition(
	token: lexer.Token | undefined,
): lexer.SimpleToken | undefined {
	let tokenCopy: lexer.SimpleToken | undefined = structuredClone(token)
	if (tokenCopy) {
		;(tokenCopy as any).position = undefined
		return tokenCopy
	}

	return undefined
}

export function symbol(array: Array<{ position: common.Position }>) {
	return { position: array[0].position }
}

export function first<T = any>(array: Array<T>) {
	return array[0]
}

export function second<T = any>(array: Array<T>) {
	return array[1]
}

export function third<T = any>(array: Array<T>) {
	return array[2]
}

export function flatten<T = any>(array: Array<T | Array<T>>): Array<T> {
	return array.reduce<Array<T>>((prev, curr) => {
		let result: Array<T>

		if (Array.isArray(curr)) {
			result = prev.concat(curr)
		} else {
			prev.push(curr)
			result = prev
		}

		return result
	}, [])
}

export function resolveOverloadedMethodName(name: string, index: number) {
	return `${name}__overload$${index + 1}`
}

// #region Generic Inference

export type GenericBindings = Map<common.GenericName, common.Type>

// NOTE: The mutable state of one inference — `bindableNames` holds the Type
// Parameters the current invocation may bind, `bindings` the Types they have
// been bound to so far. Generics outside of `bindableNames` stay opaque
// symbols that only match themselves.
export type GenericInferenceContext = {
	bindableNames: Set<common.GenericName>
	bindings: GenericBindings
}

// NOTE: `infer` Generics start unbound and re-bind on every invocation.
// Plain Generics bind at definition time — their default Type is seeded as
// an immutable binding; without a default they stay opaque and can never be
// bound, which the caller reports at the invocation.
export function createInferenceContext(
	generics: Array<common.GenericDeclaration>,
	seededBindings: GenericBindings | null = null,
): GenericInferenceContext {
	let bindableNames = new Set<common.GenericName>()
	let bindings: GenericBindings = new Map()

	for (let generic of generics) {
		if (generic.infer) {
			bindableNames.add(generic.name)
		} else if (generic.defaultType !== null) {
			bindableNames.add(generic.name)
			bindings.set(generic.name, generic.defaultType)
		}
	}

	if (seededBindings !== null) {
		for (let [name, type] of seededBindings) {
			if (bindableNames.has(name)) {
				bindings.set(name, type)
			}
		}
	}

	return { bindableNames, bindings }
}

// NOTE: Substitutes bound Generics in `type` — unbound bindable Generics are
// left untouched, opaque Generics always are.
export function applyGenericBindings(
	type: common.Type,
	bindings: GenericBindings,
): common.Type {
	switch (type.type) {
		case "GenericUse":
			return bindings.get(type.name) ?? type
		case "List": {
			let itemType = applyGenericBindings(type.itemType, bindings)

			return itemType === type.itemType
				? type
				: { type: "List", itemType }
		}
		case "UnionType": {
			let types = type.types.map((memberType) =>
				applyGenericBindings(memberType, bindings),
			)
			let aliasArguments = type.alias?.typeArguments.map((typeArgument) =>
				applyGenericBindings(typeArgument, bindings),
			)

			if (
				types.every(
					(memberType, index) => memberType === type.types[index],
				) &&
				(aliasArguments === undefined ||
					aliasArguments.every(
						(typeArgument, index) =>
							typeArgument === type.alias?.typeArguments[index],
					))
			) {
				return type
			}

			// NOTE: A plain `name` cannot follow a substitution — it might
			// spell out the very Type Parameters being replaced — so it is
			// dropped rather than kept stale. Parameter-free named Unions
			// (`Number`, a Choice) come back untouched member by member and
			// survive through the identity check above. An `alias` carries
			// its Type Arguments as Types, so it substitutes right along and
			// `Optional<ItemType>` heals into `Optional<Integer>`.
			let substituted: common.UnionType = { type: "UnionType", types }

			if (type.alias !== undefined && aliasArguments !== undefined) {
				substituted.alias = {
					name: type.alias.name,
					typeArguments: aliasArguments,
				}
			}

			return substituted
		}
		case "Record": {
			let entries = Object.entries(type.members).map(
				([name, memberType]) =>
					[name, applyGenericBindings(memberType, bindings)] as const,
			)

			if (
				entries.every(
					([name, memberType]) => memberType === type.members[name],
				)
			) {
				return type
			}

			return { type: "Record", members: Object.fromEntries(entries) }
		}
		case "Case": {
			let entries = Object.entries(type.members).map(
				([name, memberType]) =>
					[name, applyGenericBindings(memberType, bindings)] as const,
			)

			if (
				entries.every(
					([name, memberType]) => memberType === type.members[name],
				)
			) {
				return type
			}

			return { ...type, members: Object.fromEntries(entries) }
		}
		case "Function":
		case "SimpleMethod":
		case "StaticMethod":
			return {
				...type,
				// NOTE: Spread rather than rebuilt — a Parameter carries what
				// documents it, and binding a Generic must not lose that.
				parameterTypes: type.parameterTypes.map((parameter) => ({
					...parameter,
					type: applyGenericBindings(parameter.type, bindings),
				})),
				returnType: applyGenericBindings(type.returnType, bindings),
			}
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return {
				...type,
				overloads: type.overloads.map((overload) => ({
					...overload,
					parameterTypes: overload.parameterTypes.map(
						(parameter) => ({
							...parameter,
							type: applyGenericBindings(
								parameter.type,
								bindings,
							),
						}),
					),
					returnType: applyGenericBindings(
						overload.returnType,
						bindings,
					),
				})),
			}
		default:
			return type
	}
}

// NOTE: Handles an expected or actual GenericUse — the first occurrence of a
// bindable Generic binds the Type on the other side, every later occurrence
// substitutes the binding and re-checks with the normal assignability rules.
function matchGenericUse(
	generic: common.GenericUse,
	otherType: common.Type,
	context: GenericInferenceContext | null,
	checkAgainstBinding: (binding: common.Type) => boolean,
): boolean {
	if (context?.bindableNames.has(generic.name)) {
		let binding = context.bindings.get(generic.name)

		if (binding !== undefined) {
			return checkAgainstBinding(binding)
		}

		context.bindings.set(generic.name, otherType)

		return true
	}

	// NOTE: A Generic that is not bindable here is an opaque symbol of an
	// enclosing definition — it only matches itself, which the caller has
	// already checked.
	return false
}

// NOTE: The failure fallback of Union-against-Union matching with an
// inference context — it only ever turns a rejection into an acceptance, so
// every match that succeeded before still succeeds unchanged. When the
// whole-member pass fails and the expected Union carries exactly one
// still-unbound `infer` Generic, the actual Union is flattened, the concrete
// expected members claim the members they accept, and the Generic binds the
// Union of the leftovers. This is what resolves `otherwise` on a receiver
// like `MaybeInt | Rational` (with `type MaybeInt = Integer | Nothing`):
// `Nothing` claims MaybeInt's buried `Nothing`, and `ItemType` binds
// `Integer | Rational`. The whole-member pass keeps first claim, so an
// Optional-shaped receiver still binds its payload in one piece and this
// path never runs for it.
function matchUnionRemainder(
	lhs: common.UnionType,
	rhs: common.UnionType,
	context: GenericInferenceContext | null,
	snapshot: GenericBindings | null,
): boolean {
	if (context === null || snapshot === null) {
		return false
	}

	// NOTE: The failed whole-member pass may have bound Generics on its way
	// down — those bindings are rolled back before the remainder is collected.
	context.bindings.clear()

	for (let [name, binding] of snapshot) {
		context.bindings.set(name, binding)
	}

	let unboundGenericMembers = lhs.types.filter(
		(member): member is common.GenericUse =>
			member.type === "GenericUse" &&
			context.bindableNames.has(member.name) &&
			!context.bindings.has(member.name),
	)

	if (unboundGenericMembers.length !== 1) {
		return false
	}

	let genericMember = unboundGenericMembers[0]
	let concreteMembers = lhs.types.filter((member) => member !== genericMember)

	let leftovers: Array<common.Type> = []

	for (let actualMember of flattenUnionMembers(rhs)) {
		let claimed = concreteMembers.some((concreteMember) =>
			matchTypes(concreteMember, actualMember, context),
		)

		if (!claimed) {
			leftovers.push(actualMember)
		}
	}

	if (leftovers.length > 0) {
		context.bindings.set(genericMember.name, buildUnion(leftovers))
	}

	return true
}

// NOTE: Members that would bind a still-unbound Generic are tried last, so
// that a Union member with a concrete counterpart does not get eaten by a
// greedy first-occurrence binding (`Nothing` must match the `Nothing` member
// of `Value | Nothing`, not bind `Value`).
function orderUnionMembersForMatching(
	types: Array<common.Type>,
	context: GenericInferenceContext | null,
): Array<common.Type> {
	if (context === null) {
		return types
	}

	let bindingMembers: Array<common.Type> = []
	let concreteMembers: Array<common.Type> = []

	for (let type of types) {
		if (
			type.type === "GenericUse" &&
			context.bindableNames.has(type.name) &&
			!context.bindings.has(type.name)
		) {
			bindingMembers.push(type)
		} else {
			concreteMembers.push(type)
		}
	}

	return [...concreteMembers, ...bindingMembers]
}

// #endregion

// NOTE: A signature is substitutable when the actual signature accepts at
// least what the expected signature promises to feed it (contravariant
// parameter types) and returns no more than the expected signature promises
// to yield (covariant return type).
// This accepts an actual `(_ a: A | B) -> X` where `(_ a: A) -> X` is
// expected, and rejects the unsafe reverse direction.
// External parameter names are part of the call syntax and must match exactly.
function signatureMatches(
	expected: common.BaseFunction,
	actual: common.BaseFunction,
	context: GenericInferenceContext | null,
): boolean {
	if (expected.parameterTypes.length !== actual.parameterTypes.length) {
		return false
	}

	for (let i = 0; i < expected.parameterTypes.length; i++) {
		if (expected.parameterTypes[i].name !== actual.parameterTypes[i].name) {
			return false
		}

		if (
			!matchTypes(
				actual.parameterTypes[i].type,
				expected.parameterTypes[i].type,
				context,
			)
		) {
			return false
		}
	}

	return matchTypes(expected.returnType, actual.returnType, context)
}

// #region Protocol Conformance

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
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null"
	}

	if (Array.isArray(value)) {
		return `[${value.map(stableSerialize).join(",")}]`
	}

	let entries = Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, val]) => `${JSON.stringify(key)}:${stableSerialize(val)}`)

	return `{${entries.join(",")}}`
}

// NOTE: Whether a Type mentions a Generic anywhere in its tree. Types are
// plain data, so a structural walk covers every shape — including ones added
// later — without enumerating them. Used to reject `where` conditions on a
// Type Parameter the target Type never carries: unification could never bind
// such a Generic, so no use site could ever produce its witness.
export function typeMentionsGeneric(
	type: common.Type,
	genericName: string,
): boolean {
	let walk = (value: unknown): boolean => {
		if (value === null || typeof value !== "object") {
			return false
		}

		if (Array.isArray(value)) {
			return value.some(walk)
		}

		let record = value as Record<string, unknown>

		if (record.type === "GenericUse" && record.name === genericName) {
			return true
		}

		return Object.values(record).some(walk)
	}

	return walk(type)
}

export type ConformanceCheckResult =
	| { kind: "conforms"; methodMap: ConformanceMethodMap }
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
): ConformanceCheckResult {
	let methodMap: ConformanceMethodMap = {}
	let selfBindings: GenericBindings = new Map([["Self", target]])

	for (let [methodName, requirement] of Object.entries(protocol.methods)) {
		let substituted = applyGenericBindings(
			requirement,
			selfBindings,
		) as common.MethodType

		// NOTE: Object.hasOwn, not a plain index — a Method named `toString`
		// would otherwise find Object.prototype.toString on the record.
		if (!Object.hasOwn(namespace.methods, methodName)) {
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

			let bound = firstUnassumedBound(fulfilling.method, assumptions)

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

				let bound = firstUnassumedBound(fulfilling.method, assumptions)

				if (bound !== null) {
					return { kind: "needs-condition", methodName, ...bound }
				}

				methodMap[resolveOverloadedMethodName(methodName, index)] =
					fulfilling.name
			}
		}
	}

	return { kind: "conforms", methodMap }
}

// NOTE: The first bound the fulfilling Method carries that the conformance was
// not told to assume — `null` when every bound is covered (or there are none).
function firstUnassumedBound(
	method: common.BaseFunction,
	assumptions: ReadonlyMap<string, string>,
): { genericName: string; protocolName: string } | null {
	for (let generic of method.generics) {
		if (
			generic.constraint != null &&
			assumptions.get(generic.name) !== generic.constraint
		) {
			return {
				genericName: generic.name,
				protocolName: generic.constraint,
			}
		}
	}

	return null
}

// NOTE: A Simple requirement is fulfilled by a Simple Method or by the first
// matching overload of an Overloaded one — mirroring how invocations resolve
// their overload. Staticness must agree; the emitted name of the fulfilling
// Method (with its own overload suffix) and the Method itself are returned, the
// latter so its own Protocol bounds can be inspected.
function findFulfillingMethod(
	methodName: string,
	requirement: common.BaseFunction,
	requiresStatic: boolean,
	implementation: common.MethodType,
): { name: string; method: common.BaseFunction } | null {
	if (
		implementation.type === "SimpleMethod" ||
		implementation.type === "StaticMethod"
	) {
		if ((implementation.type === "StaticMethod") !== requiresStatic) {
			return null
		}

		return signatureMatches(requirement, implementation, null)
			? { name: methodName, method: implementation }
			: null
	}

	if ((implementation.type === "OverloadedStaticMethod") !== requiresStatic) {
		return null
	}

	for (let [index, overload] of implementation.overloads.entries()) {
		if (signatureMatches(requirement, overload, null)) {
			return {
				name: resolveOverloadedMethodName(methodName, index),
				method: overload,
			}
		}
	}

	return null
}

// #endregion

export function flattenUnionMembers(
	type: common.UnionType,
): Array<common.Type> {
	let members: Array<common.Type> = []

	for (let member of type.types) {
		if (member.type === "UnionType") {
			members.push(...flattenUnionMembers(member))
		} else {
			members.push(member)
		}
	}

	return members
}

// NOTE: Like `flattenUnionMembers`, except a *named* nested Union (a Choice,
// `Number`, a named Type Alias, or an applied `Optional<X>`) stays whole.
// Union-building code uses this so Hovers and Diagnostics keep the name
// instead of spelling out every member — purely a display concern, since
// assignability ignores Union names and recurses into nested Unions either
// way.
export function unionMembersKeepingNames(
	type: common.UnionType,
): Array<common.Type> {
	let members: Array<common.Type> = []

	for (let member of type.types) {
		if (
			member.type === "UnionType" &&
			member.name === undefined &&
			member.alias === undefined
		) {
			members.push(...unionMembersKeepingNames(member))
		} else {
			members.push(member)
		}
	}

	return members
}

export function matchesType(lhs: common.Type, rhs: common.Type): boolean {
	return matchTypes(lhs, rhs, null)
}

// NOTE: The Union `itemType | Nothing`, carrying the applied `Optional<...>`
// spelling for display. The stdlib writes its fallible signatures with this,
// so Hovers and Diagnostics print the global alias — and a compound payload
// stays one nested member (`Optional<Integer | Rational>`), which is what
// lets `otherwise` bind it in one piece.
export function optionalOf(itemType: common.Type): common.UnionType {
	return {
		type: "UnionType",
		types: [itemType, { type: "Nothing" }],
		alias: { name: "Optional", typeArguments: [itemType] },
	}
}

// NOTE: Builds a Union in its canonical, Optional-shaped form: `Nothing` is
// hoisted to a single top-level member and every other member becomes the
// payload — one member, or one anonymous nested Union of them. So
// `Integer | Rational | Nothing` is built as `(Integer | Rational) | Nothing`,
// which is what lets `otherwise` (and any Generic bound over `T | Nothing`)
// bind the payload in one piece — while an anonymous nested payload still
// prints member by member, exactly as written.
//
// Members that subsume one another collapse (`Integer` alongside `Number`
// becomes just `Number`); named Unions (`Number`, a Choice, a named Alias)
// stay whole; an applied `Optional<X>` member surrenders its payload and its
// `Nothing` only when it has to merge with other members — on its own it is
// returned as written.
export function buildUnion(members: Array<common.Type>): common.Type {
	// NOTE: Subsumption runs before decomposition, so `Optional<Rational>`
	// next to a plain `nothing` collapses to just `Optional<Rational>` and
	// keeps its spelling instead of being taken apart.
	let distinct: Array<common.Type> = []

	for (let member of members) {
		if (distinct.some((existing) => matchesType(existing, member))) {
			continue
		}

		distinct = distinct.filter((existing) => !matchesType(member, existing))
		distinct.push(member)
	}

	if (distinct.length === 1) {
		return distinct[0]
	}

	let hasNothing = false
	let payloadMembers: Array<common.Type> = []

	let collect = (member: common.Type) => {
		if (member.type === "Nothing") {
			hasNothing = true
			return
		}

		if (member.type === "UnionType") {
			if (member.name === undefined && member.alias === undefined) {
				for (let nestedMember of member.types) {
					collect(nestedMember)
				}

				return
			}

			// NOTE: An aliased Union that carries a `Nothing` (`Optional<X>`)
			// gives it up to the top level here — buried inside a payload
			// member it would be invisible to `otherwise`. Named Unions keep
			// their members regardless: their name is their spelling.
			if (
				member.alias !== undefined &&
				flattenUnionMembers(member).some(
					(nestedMember) => nestedMember.type === "Nothing",
				)
			) {
				for (let nestedMember of member.types) {
					collect(nestedMember)
				}

				return
			}
		}

		payloadMembers.push(member)
	}

	for (let member of distinct) {
		collect(member)
	}

	// NOTE: Decomposition can surface duplicates — `Optional<Integer>` next
	// to a plain `Integer` — so the payload subsumes once more.
	let payload: Array<common.Type> = []

	for (let member of payloadMembers) {
		if (payload.some((existing) => matchesType(existing, member))) {
			continue
		}

		payload = payload.filter((existing) => !matchesType(member, existing))
		payload.push(member)
	}

	if (payload.length === 0) {
		return { type: "Nothing" }
	}

	let payloadType: common.Type =
		payload.length === 1
			? payload[0]
			: { type: "UnionType", types: payload }

	if (!hasNothing) {
		return payloadType
	}

	return {
		type: "UnionType",
		types: [payloadType, { type: "Nothing" }],
	}
}

// NOTE: The deduped member list for a Union built from several candidate
// Types. Anonymous (unnamed, unaliased) nested Unions are exploded so their
// members merge in; a named nested Union (`Number`, a Choice, a named Alias)
// stays whole so the result prints by name. A member already subsumed by one
// present is dropped, and a member that subsumes present ones evicts them — so
// `Integer` and `Number` collapse to `Number` rather than sitting side by
// side. The caller decides how to finish: an empty list, a lone member, or
// `buildUnion` over the rest.
export function mergeUnionMembers(
	types: Array<common.Type>,
): Array<common.Type> {
	let distinct: Array<common.Type> = []

	for (let type of types) {
		let members =
			type.type === "UnionType" &&
			type.name === undefined &&
			type.alias === undefined
				? unionMembersKeepingNames(type)
				: [type]

		for (let member of members) {
			if (distinct.some((existing) => matchesType(existing, member))) {
				continue
			}

			distinct = distinct.filter(
				(existing) => !matchesType(member, existing),
			)
			distinct.push(member)
		}
	}

	return distinct
}

// NOTE: The inference-aware form of `matchesType` — the first occurrence of
// a bindable Generic (in `context.bindableNames`) binds the Type on the
// other side, every later occurrence checks with the normal assignability
// rules. Bindings accumulate in `context.bindings`.
export function matchesTypeWithBindings(
	lhs: common.Type,
	rhs: common.Type,
	context: GenericInferenceContext,
): boolean {
	return matchTypes(lhs, rhs, context)
}

function matchTypes(
	lhs: common.Type,
	rhs: common.Type,
	context: GenericInferenceContext | null,
): boolean {
	// NOTE: Error Types are poison values — they only occur after a
	// Diagnostic has already been reported, and match anything in both
	// directions so that a single mistake does not cascade into
	// follow-up Diagnostics.
	if (lhs.type === "Error" || rhs.type === "Error") {
		return true
	}

	// NOTE: A Generic always matches itself, bindable or not.
	if (
		lhs.type === "GenericUse" &&
		rhs.type === "GenericUse" &&
		lhs.name === rhs.name
	) {
		return true
	}

	// NOTE: Generics can occur on either side — an expected Generic binds the
	// actual Type, while an actual-side Generic occurs when signatures are
	// compared (contravariant parameter positions flip the sides).
	if (lhs.type === "GenericUse" && context?.bindableNames.has(lhs.name)) {
		return matchGenericUse(lhs, rhs, context, (binding) =>
			matchTypes(binding, rhs, context),
		)
	}

	if (rhs.type === "GenericUse" && context?.bindableNames.has(rhs.name)) {
		return matchGenericUse(rhs, lhs, context, (binding) =>
			matchTypes(lhs, binding, context),
		)
	}

	// NOTE: An opaque Generic is a symbol of an enclosing definition — as the
	// expected Type it only accepts itself, which the same-name check above
	// already covered. As the actual Type it falls through, so that an
	// expected Union can still accept its own Generic member.
	if (lhs.type === "GenericUse") {
		return false
	}

	if (lhs.type === "Unknown") {
		return true
	}

	if (
		(lhs.type === "GenericList" || lhs.type === "List") &&
		rhs.type === "GenericList"
	) {
		return true
	}

	if (lhs.type === "GenericList" && rhs.type === "List") {
		return true
	}

	if (lhs.type === "List" && rhs.type === "List") {
		// NOTE: Empty List Literals have an Unknown itemType and
		// are assignable to any List.
		if (rhs.itemType.type === "Unknown") {
			return true
		}

		return matchTypes(lhs.itemType, rhs.itemType, context)
	}

	if (lhs.type === "Nothing" && rhs.type === "Nothing") {
		return true
	}

	if (lhs.type === "String" && rhs.type === "String") {
		return true
	}

	if (lhs.type === "Boolean" && rhs.type === "Boolean") {
		return true
	}

	if (lhs.type === "Integer" && rhs.type === "Integer") {
		return true
	}

	if (lhs.type === "Rational" && rhs.type === "Rational") {
		return true
	}

	if (lhs.type === "Algebraic" && rhs.type === "Algebraic") {
		return true
	}

	if (lhs.type === "Transcendental" && rhs.type === "Transcendental") {
		return true
	}

	if (lhs.type === "UnionType") {
		let lhsMembers = orderUnionMembersForMatching(lhs.types, context)

		if (rhs.type === "UnionType") {
			// NOTE: An actual Union is assignable when every one of its
			// members is accepted by some member of the expected Union — the
			// actual Type must not be able to hold any value the expected
			// Type can not hold. A whole member is tried first, so a binding
			// Generic binds a nested Union (`Optional<Integer | Rational>`'s
			// payload) in one piece; only when no single expected member takes
			// it is a nested actual member decomposed against the whole
			// expected Union, which makes the nested and the flattened
			// spelling of the same Union interchangeable.
			let snapshot = context === null ? null : new Map(context.bindings)
			let matchedWholeMembers = true

			for (let rhsType of rhs.types) {
				let foundMatch = false

				for (let lhsType of lhsMembers) {
					if (matchTypes(lhsType, rhsType, context)) {
						foundMatch = true
						break
					}
				}

				if (!foundMatch && rhsType.type === "UnionType") {
					foundMatch = matchTypes(lhs, rhsType, context)
				}

				if (!foundMatch) {
					matchedWholeMembers = false
					break
				}
			}

			if (matchedWholeMembers) {
				return true
			}

			return matchUnionRemainder(lhs, rhs, context, snapshot)
		} else {
			for (let type of lhsMembers) {
				if (matchTypes(type, rhs, context)) {
					return true
				}
			}
		}

		return false
	}

	// NOTE: Cases are nominal — a Case only matches its own Choice's Case of
	// the same name, never a structurally identical Record (and vice versa).
	// That identity is the entire point of declaring a Choice.
	if (lhs.type === "Case" && rhs.type === "Case") {
		return lhs.choice === rhs.choice && lhs.name === rhs.name
	}

	if (lhs.type === "Record" && rhs.type === "Record") {
		for (let memberName in lhs.members) {
			if (rhs.members[memberName] === undefined) {
				return false
			}

			if (
				!matchTypes(
					lhs.members[memberName],
					rhs.members[memberName],
					context,
				)
			) {
				return false
			}
		}

		return true
	}

	if (
		(lhs.type === "Function" && rhs.type === "Function") ||
		(lhs.type === "SimpleMethod" && rhs.type === "SimpleMethod") ||
		(lhs.type === "StaticMethod" && rhs.type === "StaticMethod")
	) {
		return signatureMatches(lhs, rhs, context)
	}

	if (
		(lhs.type === "OverloadedMethod" && rhs.type === "OverloadedMethod") ||
		(lhs.type === "OverloadedStaticMethod" &&
			rhs.type === "OverloadedStaticMethod")
	) {
		if (lhs.overloads.length !== rhs.overloads.length) {
			return false
		}

		for (let i = 0; i < lhs.overloads.length; i++) {
			if (
				!signatureMatches(lhs.overloads[i], rhs.overloads[i], context)
			) {
				return false
			}
		}

		return true
	}

	return false
}

// NOTE: The Argument Type is provided lazily — resolving an Argument's Type
// in the Enricher can report Diagnostics, so `getType` is only invoked for
// Arguments whose label already matched, exactly like the previous inline
// checks did.
// `expectedType` is the parameter's Type with whatever has been inferred so
// far substituted in. A Function literal that omitted its annotations reads
// them off it; every other Argument ignores it entirely.
export type MatchableArgument = {
	name: string | null
	getType: (expectedType: common.Type) => common.Type
}

export type ArgumentMatchResult =
	| { type: "Match" }
	| { type: "ArityMismatch" }
	| { type: "ArgumentMismatch"; mismatchedArgumentIndices: Array<number> }

// NOTE: Checks whether passed Arguments match a parameter list — arity,
// labels (matched by name equality; a labelless Argument only matches a
// labelless parameter), and per-Argument `matchesType`.
// By default the check stops at the first mismatching Argument, which callers
// that only need a boolean "does this overload match" rely on to avoid
// resolving further Argument Types. With `collectAllMismatches` every
// mismatching Argument index is collected, which the Validator uses to report
// one Diagnostic per mismatching Argument.
// With `inference` the Arguments are matched left to right against a Generic
// signature — the first occurrence of a bindable Generic binds the Argument's
// Type, later occurrences check against the binding. Callers pass a fresh
// context per overload candidate, so bindings can not leak between
// candidates.
export function matchArguments(
	parameters: common.BaseFunction["parameterTypes"],
	matchableArguments: Array<MatchableArgument>,
	options: {
		collectAllMismatches?: boolean
		inference?: GenericInferenceContext
	} = {},
): ArgumentMatchResult {
	if (parameters.length !== matchableArguments.length) {
		return { type: "ArityMismatch" }
	}

	let inferenceContext = options.inference ?? null
	let mismatchedArgumentIndices: Array<number> = []

	for (let i = 0; i < parameters.length; i++) {
		let parameter = parameters[i]
		let argument = matchableArguments[i]

		// NOTE: Arguments bind left to right, so by the time a callback is
		// reached the Generics its Parameters mention have usually been bound
		// by earlier Arguments — substituting them is what turns `map`'s
		// declared `(_ item: ItemType) -> Result` into the `(_ item: Integer)
		// -> Result` the literal is actually resolved against.
		let expectedType =
			inferenceContext === null
				? parameter.type
				: applyGenericBindings(
						parameter.type,
						inferenceContext.bindings,
					)

		if (
			parameter.name !== argument.name ||
			!matchTypes(
				parameter.type,
				argument.getType(expectedType),
				inferenceContext,
			)
		) {
			if (!options.collectAllMismatches) {
				return {
					type: "ArgumentMismatch",
					mismatchedArgumentIndices: [i],
				}
			}

			mismatchedArgumentIndices.push(i)
		}
	}

	if (mismatchedArgumentIndices.length > 0) {
		return { type: "ArgumentMismatch", mismatchedArgumentIndices }
	}

	return { type: "Match" }
}
