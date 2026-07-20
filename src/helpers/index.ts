import type { common, lexer } from "../interfaces/index"

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
		case "List":
			return {
				type: "List",
				itemType: applyGenericBindings(type.itemType, bindings),
			}
		case "UnionType":
			return {
				type: "UnionType",
				types: type.types.map((memberType) =>
					applyGenericBindings(memberType, bindings),
				),
			}
		case "Record":
			return {
				type: "Record",
				members: Object.fromEntries(
					Object.entries(type.members).map(([name, memberType]) => [
						name,
						applyGenericBindings(memberType, bindings),
					]),
				),
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

export function matchesType(lhs: common.Type, rhs: common.Type): boolean {
	return matchTypes(lhs, rhs, null)
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

	if (lhs.type === "Fraction" && rhs.type === "Fraction") {
		return true
	}

	if (lhs.type === "UnionType") {
		let lhsMembers = orderUnionMembersForMatching(lhs.types, context)

		if (rhs.type === "UnionType") {
			// NOTE: An actual Union is assignable when every one of its
			// members is accepted by some member of the expected Union — the
			// actual Type must not be able to hold any value the expected
			// Type can not hold.
			for (let rhsType of rhs.types) {
				let foundMatch = false

				for (let lhsType of lhsMembers) {
					if (matchTypes(lhsType, rhsType, context)) {
						foundMatch = true
						break
					}
				}

				if (!foundMatch) {
					return false
				}
			}

			return true
		} else {
			for (let type of lhsMembers) {
				if (matchTypes(type, rhs, context)) {
					return true
				}
			}
		}

		return false
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
export type MatchableArgument = {
	name: string | null
	getType: () => common.Type
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

		if (
			parameter.name !== argument.name ||
			!matchTypes(parameter.type, argument.getType(), inferenceContext)
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
