import type { common } from "@essence-lang/interfaces"

// The suffix the Simplifier mangles an Overload's name with.
const OVERLOAD_SUFFIX = "__overload$"

export function resolveOverloadedMethodName(name: string, index: number) {
	return `${name}${OVERLOAD_SUFFIX}${index + 1}`
}

// The Overload a mangled name names, counting from zero, or null for a name
// without the suffix, as a Method with one Overload emits.
export function overloadIndexOf(name: string): number | null {
	let suffix = name.indexOf(OVERLOAD_SUFFIX)

	if (suffix === -1) {
		return null
	}

	let index = Number(name.slice(suffix + OVERLOAD_SUFFIX.length))

	return Number.isInteger(index) && index > 0 ? index - 1 : null
}

// The unit Type, the empty Record `{}`: nothing can be read off it. The
// Validator lets a body that promises it fall off its end.
export function isUnitType(type: common.Type): boolean {
	return type.type === "Record" && Object.keys(type.members).length === 0
}

// What a `<-` in a body answers with: the declared Type, or the inner Type of a
// completing body's declared Future. A completing body declaring no Future has
// been reported already, so it answers what it declared.
export function returnedTypeOf(
	declared: common.Type,
	completing: boolean,
): common.Type {
	return completing && declared.type === "Future"
		? declared.valueType
		: declared
}

// The asynchrony a Type mismatch is one word short of, or null. Each is decided
// by assignability, so a `Future<Integer>` where a String is wanted is null.
//   - `"unstarted"`: a `Future<T>` stands where its `T` is wanted.
//   - `"in-flight"`: a `Started<T>` stands where its `T` is wanted.
//   - `"not-a-future"`: a `T` stands where a `Future<T>` is wanted.
export type AsynchronyMismatch = "unstarted" | "in-flight" | "not-a-future"

export function asynchronyMismatch(
	expected: common.Type,
	actual: common.Type,
): AsynchronyMismatch | null {
	if (
		(actual.type === "Future" || actual.type === "Started") &&
		expected.type !== actual.type &&
		matchesType(expected, actual.valueType)
	) {
		return actual.type === "Future" ? "unstarted" : "in-flight"
	}

	if (
		expected.type === "Future" &&
		actual.type !== "Future" &&
		matchesType(expected.valueType, actual)
	) {
		return "not-a-future"
	}

	return null
}

// The display field `typeWalkFinds` does not follow. The walk asks whether
// `found` holds of any object a Type is built from, visiting each once. See
// "Walking a Type" in DEVELOPMENT.md.
const displaySpelling = "alias"

function typeWalkFinds(
	type: common.Type,
	found: (record: Record<string, unknown>) => boolean,
): boolean {
	let visited = new Set<object>()

	let walk = (value: unknown): boolean => {
		if (value === null || typeof value !== "object") {
			return false
		}

		if (visited.has(value)) {
			return false
		}

		visited.add(value)

		if (Array.isArray(value)) {
			return value.some(walk)
		}

		let record = value as Record<string, unknown>

		if (found(record)) {
			return true
		}

		// Only a Type with an `alias` takes the slower walk over its entries.
		if (
			record[displaySpelling] === undefined ||
			(record.type !== "Record" && record.type !== "UnionType")
		) {
			return Object.values(record).some(walk)
		}

		return Object.entries(record).some(
			([key, member]) => key !== displaySpelling && walk(member),
		)
	}

	return walk(type)
}

// #region Generic Inference

export type GenericBindings = Map<common.GenericName, common.Type>

// The mutable state of one inference: the Type Parameters this call may bind,
// and their bindings so far. Any other Generic matches only itself.
export type GenericInferenceContext = {
	bindableNames: Set<common.GenericName>
	bindings: GenericBindings
	// The unbound Type Parameters an Error met, for `settleErrorBindings`.
	metError?: Set<common.GenericName>
}

// An `infer` Generic starts unbound on every call. A plain one is bound to its
// default Type, or stays opaque without one, which the caller reports.
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

// A counter for fresh names. Only its uniqueness matters, and it never reaches
// a Type a Program can observe, so compiling stays deterministic.
let freshGenericCounter = 0

// What separates a fresh Generic's name from its counter. No written Generic
// can hold it.
const freshGenericSeparator = "\u200B"

// Whether a Type still holds a fresh Type Parameter this call has not solved.
// Such a slot is undecided, where an enclosing Function's own Type Parameter is
// a decision, so it must never be recorded as one.
export function mentionsUnsolvedTypeParameter(type: common.Type): boolean {
	return typeWalkFinds(
		type,
		(record) =>
			record.type === "GenericUse" &&
			typeof record.name === "string" &&
			record.name.includes(freshGenericSeparator),
	)
}

// Renames a signature's Generics to fresh names for one call's Argument
// matching, so a caller's same-named Generic can not collide with them. See
// "Freshened Type Parameters" in DEVELOPMENT.md.
export function createFreshenedInference(signature: common.BaseFunction): {
	parameterTypes: common.BaseFunction["parameterTypes"]
	context: GenericInferenceContext
	freshToOriginal: Map<common.GenericName, common.GenericName>
} {
	if (signature.generics.length === 0) {
		return {
			parameterTypes: signature.parameterTypes,
			context: {
				bindableNames: new Set(),
				bindings: new Map(),
			},
			freshToOriginal: new Map(),
		}
	}

	let rename: GenericBindings = new Map()
	let freshToOriginal = new Map<common.GenericName, common.GenericName>()

	for (let generic of signature.generics) {
		let freshName = `${generic.name}${freshGenericSeparator}${(freshGenericCounter += 1)}`

		freshToOriginal.set(freshName, generic.name)
		rename.set(generic.name, { type: "GenericUse", name: freshName })
	}

	let bindableNames = new Set<common.GenericName>()
	let bindings: GenericBindings = new Map()

	for (let generic of signature.generics) {
		let freshName = (rename.get(generic.name) as common.GenericUse).name

		if (generic.infer) {
			bindableNames.add(freshName)
		} else if (generic.defaultType !== null) {
			bindableNames.add(freshName)
			bindings.set(
				freshName,
				applyGenericBindings(generic.defaultType, rename),
			)
		}
	}

	let parameterTypes = signature.parameterTypes.map((parameter) => ({
		...parameter,
		type: applyGenericBindings(parameter.type, rename),
	}))

	return {
		parameterTypes,
		context: { bindableNames, bindings },
		freshToOriginal,
	}
}

// `matchArguments` over a freshened signature. A refusal carries what the
// inference bound, under the signature's own names. A report then judges a
// refused Argument against the Type Parameters the others decided.
export function matchFreshened(
	inference: ReturnType<typeof createFreshenedInference>,
	matchableArguments: Array<MatchableArgument>,
	collectAllMismatches: boolean,
): ArgumentMatchResult {
	let result = matchArguments(inference.parameterTypes, matchableArguments, {
		collectAllMismatches,
		inference: inference.context,
	})

	if (result.type !== "ArgumentMismatch") {
		return result
	}

	let rename: GenericBindings = new Map()
	let decided: GenericBindings = new Map()

	for (let [fresh, original] of inference.freshToOriginal) {
		rename.set(fresh, { type: "GenericUse", name: original })
	}

	for (let [fresh, bound] of inference.context.bindings) {
		let original = inference.freshToOriginal.get(fresh)

		if (original !== undefined) {
			decided.set(original, applyGenericBindings(bound, rename))
		}
	}

	return { ...result, decided }
}

// A Choice's Type Parameters renamed fresh for the payload match that binds
// them. An unbound one keeps its fresh name. See "Freshened Type Parameters" in
// DEVELOPMENT.md.
export function createFreshenedChoiceInference(
	choiceGenerics: Array<common.GenericDeclaration>,
): {
	rename: GenericBindings
	freshNames: Array<common.GenericName>
	context: GenericInferenceContext
} {
	let rename: GenericBindings = new Map()
	let freshNames: Array<common.GenericName> = []

	for (let generic of choiceGenerics) {
		let freshName = `${generic.name}${freshGenericSeparator}${(freshGenericCounter += 1)}`

		freshNames.push(freshName)
		rename.set(generic.name, { type: "GenericUse", name: freshName })
	}

	return {
		rename,
		freshNames,
		context: {
			// Every one binds, since a Choice's Type Parameters are applied, not
			// declared `infer`.
			bindableNames: new Set(freshNames),
			bindings: new Map(),
		},
	}
}

// The stable name a fabricated signature borrows a Type Parameter under, so
// freshening never pins a Parameter to itself. See "Freshened Type Parameters" in
// DEVELOPMENT.md.
export function borrowedGenericName(
	name: common.GenericName,
): common.GenericName {
	return `${name}${freshGenericSeparator}`
}

// Substitutes each binding of one call into the others until nothing moves,
// while the names are fresh. Capped at one pass per binding. See "Freshened Type
// Parameters" in DEVELOPMENT.md.
function settlePins(bindings: GenericBindings): GenericBindings {
	let settled = bindings

	for (let pass = 0; pass < bindings.size; pass += 1) {
		let next: GenericBindings = new Map()
		let moved = false

		for (let [name, type] of settled) {
			let applied = applyGenericBindings(type, settled)

			moved ||= applied !== type
			next.set(name, applied)
		}

		if (!moved) {
			return settled
		}

		settled = next
	}

	return settled
}

// Translates bindings made under fresh names back to the declared names, keys
// and values. `settlePins` first settles any `defaultType` pin under the fresh
// names.
export function unfreshenBindings(
	bindings: GenericBindings,
	freshToOriginal: Map<common.GenericName, common.GenericName>,
): GenericBindings {
	if (freshToOriginal.size === 0) {
		return bindings
	}

	// The usual case: no binding mentions a pin or a fresh name, so only the keys
	// change. The memoised mention sets answer that without a walk.
	if (!bindingsMentionAPin(bindings, freshToOriginal)) {
		let renamedKeys: GenericBindings = new Map()

		for (let [name, type] of bindings) {
			renamedKeys.set(freshToOriginal.get(name) ?? name, type)
		}

		return renamedKeys
	}

	let reverse: GenericBindings = new Map()

	for (let [fresh, original] of freshToOriginal) {
		reverse.set(fresh, { type: "GenericUse", name: original })
	}

	let result: GenericBindings = new Map()

	for (let [name, type] of settlePins(bindings)) {
		result.set(
			freshToOriginal.get(name) ?? name,
			applyGenericBindings(type, reverse),
		)
	}

	return result
}

// Whether any binding value names a Parameter this call bound or a fresh name.
// False means only the keys have to move.
function bindingsMentionAPin(
	bindings: GenericBindings,
	freshToOriginal: Map<common.GenericName, common.GenericName>,
): boolean {
	for (let [, type] of bindings) {
		for (let mentioned of mentionedGenericNames(type)) {
			if (bindings.has(mentioned) || freshToOriginal.has(mentioned)) {
				return true
			}
		}
	}

	return false
}

// A Namespace as the specificity order sees it: the target as declared, and its
// open Generics. See "Namespace targets" in DEVELOPMENT.md.
export type NamespaceTarget = {
	targetType: common.Type | null
	generics: Array<common.GenericDeclaration>
}

// A Namespace's own Generics bound from a receiver, or null where its target
// does not cover it. Every "does this Namespace target that value" question asks
// here. See "Namespace targets" in DEVELOPMENT.md.
export function bindNamespaceTarget(
	pattern: NamespaceTarget,
	subject: common.Type,
): GenericBindings | null {
	return matchNamespaceTarget(pattern, subject)?.bindings ?? null
}

// The bindings of `bindNamespaceTarget` that only the receiver's Type
// Arguments decide, since no payload names them. Null where the target does
// not cover the receiver.
export function typeArgumentBindings(
	pattern: NamespaceTarget,
	subject: common.Type,
): GenericBindings | null {
	let matched = matchNamespaceTarget(pattern, subject)

	return matched === null
		? null
		: new Map(
				[...matched.bindings].filter(([name]) =>
					matched.fromTypeArguments.has(name),
				),
			)
}

// Whether a Namespace's target covers a receiver by its payloads alone, as it
// would were the receiver's Type Arguments not asked. A Union target counts
// whole or by a member, as the lookup counts it.
export function coversApartFromTypeArguments(
	pattern: NamespaceTarget,
	subject: common.Type,
): boolean {
	let target = pattern.targetType
	let members = target?.type === "UnionType" ? target.types : []

	return [target, ...members].some((targetType) => {
		if (targetType === null) {
			return false
		}

		let renamed = renamedNamespaceTarget(targetType, pattern.generics)

		return matchesTypeWithBindings(
			renamed.target,
			subject,
			createInferenceContext(renamed.generics),
		)
	})
}

function matchNamespaceTarget(
	pattern: NamespaceTarget,
	subject: common.Type,
): {
	bindings: GenericBindings
	fromTypeArguments: Set<common.GenericName>
} | null {
	if (pattern.targetType === null) {
		return null
	}

	if (pattern.generics.length === 0) {
		return matchesType(pattern.targetType, subject) &&
			bindCaseTypeArguments(
				pattern.targetType,
				subject,
				createInferenceContext([]),
			) !== null
			? { bindings: new Map(), fromTypeArguments: new Set() }
			: null
	}

	let renamed = renamedNamespaceTarget(pattern.targetType, pattern.generics)
	let context = createInferenceContext(renamed.generics)

	if (!matchesTypeWithBindings(renamed.target, subject, context)) {
		return null
	}

	let bound = bindCaseTypeArguments(renamed.target, subject, context)

	if (bound === null) {
		return null
	}

	settleErrorBindings(context)

	return {
		bindings: unfreshenBindings(context.bindings, renamed.freshToOriginal),
		fromTypeArguments: new Set(
			[...bound].map((name) => renamed.freshToOriginal.get(name) ?? name),
		),
	}
}

// Binds the Generics a subject Case's payload leaves to its Type Arguments,
// where every such Case agrees, and answers their names. Null where a Case's
// Type Arguments fit no Case of the same tag in the pattern.
function bindCaseTypeArguments(
	pattern: common.Type,
	subject: common.Type,
	context: GenericInferenceContext,
): Set<common.GenericName> | null {
	let arms = choiceCasesOf(pattern)
	let decided = new Map<common.GenericName, Array<common.Type>>()

	for (let carrier of choiceCasesOf(subject)) {
		// Only a Case of a generic Choice carries Type Arguments.
		if (carrier.typeArguments === undefined) {
			continue
		}

		let sameTag = arms.filter(
			(arm) => arm.choice === carrier.choice && arm.name === carrier.name,
		)

		if (sameTag.length === 0) {
			continue
		}

		let fitting = sameTag
			.map((arm) => typeArgumentsFit(arm, carrier, context.bindableNames))
			.find((bindings): bindings is GenericBindings => bindings !== null)

		if (fitting === undefined) {
			return null
		}

		for (let [name, type] of fitting) {
			decided.set(name, [...(decided.get(name) ?? []), type])
		}
	}

	let bound = new Set<common.GenericName>()

	for (let [name, [first, ...rest]] of decided) {
		let agreed = rest.every(
			(type) => matchesType(first, type) && matchesType(type, first),
		)

		if (agreed && !context.bindings.has(name)) {
			context.bindings.set(name, first)
			bound.add(name)
		}
	}

	return bound
}

// What a pattern's Case binds from a subject Case's Type Arguments, or null
// where they do not fit. A Type Argument naming a Generic the pattern's payload
// names is the payload's, and so is one the subject leaves undecided.
function typeArgumentsFit(
	arm: common.CaseType,
	carrier: common.CaseType,
	bindableNames: Set<common.GenericName>,
): GenericBindings | null {
	let context: GenericInferenceContext = {
		bindableNames,
		bindings: new Map(),
	}
	let payloadNames = payloadGenericNames(arm)
	let carried = carrier.typeArguments ?? []

	for (let [index, argument] of (arm.typeArguments ?? []).entries()) {
		let actual = carried[index]

		if (
			actual === undefined ||
			typeContainsUnknown(actual) ||
			[...genericNamesMentioned(argument)].some((name) =>
				payloadNames.has(name),
			)
		) {
			continue
		}

		if (!matchTypes(argument, actual, context, NESTED)) {
			return null
		}
	}

	return context.bindings
}

// Remembered per Case, which a Namespace renames once.
const payloadGenericNamesMemo = new WeakMap<
	common.CaseType,
	Set<common.GenericName>
>()

function payloadGenericNames(arm: common.CaseType): Set<common.GenericName> {
	let remembered = payloadGenericNamesMemo.get(arm)

	if (remembered === undefined) {
		remembered = new Set(
			Object.values(arm.members).flatMap((member) => [
				...genericNamesMentioned(member),
			]),
		)
		payloadGenericNamesMemo.set(arm, remembered)
	}

	return remembered
}

// The differing Type Arguments a subject's Cases carry where a Choice pattern
// names `genericName`, or null where they agree.
export function disagreeingTypeArguments(
	pattern: common.Type,
	subject: common.Type,
	genericName: common.GenericName,
): { choice: string; arity: number; typeArguments: Array<common.Type> } | null {
	let patternCase = choiceCasesOf(pattern)[0]
	let index =
		patternCase?.typeArguments?.findIndex(
			(argument) =>
				argument.type === "GenericUse" && argument.name === genericName,
		) ?? -1

	if (patternCase === undefined || index === -1) {
		return null
	}

	let typeArguments: Array<common.Type> = []

	for (let carrier of choiceCasesOf(subject)) {
		let argument = carrier.typeArguments?.[index]

		if (carrier.choice !== patternCase.choice) {
			continue
		}

		if (argument === undefined) {
			return null
		}

		if (
			!typeArguments.some(
				(seen) =>
					matchesType(seen, argument) && matchesType(argument, seen),
			)
		) {
			typeArguments.push(argument)
		}
	}

	return typeArguments.length > 1
		? {
				choice: patternCase.choice,
				arity: patternCase.typeArguments!.length,
				typeArguments,
			}
		: null
}

function choiceCasesOf(type: common.Type): Array<common.CaseType> {
	if (type.type === "Case") {
		return [type]
	}

	return type.type === "UnionType"
		? type.types.filter(
				(member): member is common.CaseType => member.type === "Case",
			)
		: []
}

// A Namespace's Generics under fresh names, its target rewritten to use them,
// and the way back. It depends on the pattern alone.
type RenamedNamespaceTarget = {
	generics: Array<common.GenericDeclaration>
	target: common.Type
	freshToOriginal: Map<common.GenericName, common.GenericName>
	declaredGenerics: Array<common.GenericDeclaration>
}

// Keyed by the target Type object, which outlives the wrapper a caller builds
// per candidate. See "Namespace targets" in DEVELOPMENT.md.
const renamedNamespaceTargets = new WeakMap<
	common.Type,
	RenamedNamespaceTarget
>()

// One set of fresh names per Namespace, reused for every receiver. Exported for
// its spec. See "Namespace targets" in DEVELOPMENT.md.
export function renamedNamespaceTarget(
	targetType: common.Type,
	declaredGenerics: Array<common.GenericDeclaration>,
): RenamedNamespaceTarget {
	let remembered = renamedNamespaceTargets.get(targetType)

	if (
		remembered !== undefined &&
		remembered.declaredGenerics === declaredGenerics
	) {
		return remembered
	}

	let rename: GenericBindings = new Map()
	let freshToOriginal = new Map<common.GenericName, common.GenericName>()

	for (let generic of declaredGenerics) {
		let freshName = `${generic.name}${freshGenericSeparator}${(freshGenericCounter += 1)}`

		freshToOriginal.set(freshName, generic.name)
		rename.set(generic.name, { type: "GenericUse", name: freshName })
	}

	let renamed: RenamedNamespaceTarget = {
		generics: declaredGenerics.map((generic) => ({
			...generic,
			name: (rename.get(generic.name) as common.GenericUse).name,
			defaultType:
				generic.defaultType === null
					? null
					: applyGenericBindings(generic.defaultType, rename),
		})),
		target: applyGenericBindings(targetType, rename),
		freshToOriginal,
		declaredGenerics,
	}

	renamedNamespaceTargets.set(targetType, renamed)

	return renamed
}

// Whether `pattern`'s target covers `subject` with its own Generics open:
// `List<ItemType>` covers `List<Integer>`, `List<List<ItemType>>` only the nested.
function targetCoversAsPattern(
	pattern: NamespaceTarget,
	subject: common.Type,
): boolean {
	return bindNamespaceTarget(pattern, subject) !== null
}

// The specificity order over overlapping Namespaces, for dispatch and
// conformance alike. See "Specificity" in DEVELOPMENT.md.
function isStrictlyMoreSpecificTarget(
	target: NamespaceTarget,
	other: NamespaceTarget,
): boolean {
	if (target.targetType === null || other.targetType === null) {
		return false
	}

	return (
		targetCoversAsPattern(other, target.targetType) &&
		!targetCoversAsPattern(target, other.targetType)
	)
}

// Keeps the candidates no other is strictly more specific than, or all of them
// where a cyclic order would leave none.
export function filterMostSpecificByTarget<Candidate>(
	candidates: Array<Candidate>,
	targetOf: (candidate: Candidate) => NamespaceTarget,
): Array<Candidate> {
	let mostSpecific = candidates.filter(
		(candidate) =>
			!candidates.some(
				(other) =>
					other !== candidate &&
					isStrictlyMoreSpecificTarget(
						targetOf(other),
						targetOf(candidate),
					),
			),
	)

	return mostSpecific.length > 0 ? mostSpecific : candidates
}

// The copies taken of a refinement whose predicate is unread, by the object
// each was copied from. It lives only while a hoist is open. See "Pending
// refinement copies" in DEVELOPMENT.md.
let pendingRefinementCopies = new Map<
	common.RefinementType,
	Array<common.RefinementType>
>()

// Hoists nest, so the registry is opened by counting, and only the outermost
// close clears it.
let openHoists = 0

export function openPendingRefinementCopies(): void {
	openHoists += 1
}

export function closePendingRefinementCopies(): void {
	openHoists -= 1

	if (openHoists === 0) {
		pendingRefinementCopies.clear()
	}
}

// What a declaration throws when it reads something not hoisted yet, the only
// throw the rounds retry. Not an `Error`, so `toString` gives crash reports text.
export class NotHoistedYet {
	name = "NotHoistedYet"
	message: string
	// The refinement whose unread predicate was asked for, which is how
	// the fill tells which predicate waits on which.
	refinement: common.RefinementType | null

	constructor(
		message: string,
		refinement: common.RefinementType | null = null,
	) {
		this.message = message
		this.refinement = refinement
	}

	toString(): string {
		return this.message
	}
}

// During a hoist a predicate still unread asks the rounds to retry its
// reader once the predicate is filled. Outside one nothing is left to fill it,
// so reading it is a Compiler bug.
export function refusePendingPredicate(
	refinement: common.RefinementType,
): never {
	let message = `Internal Compiler Error: the predicate of refinement '${refinement.name}' was read before it resolved`

	throw openHoists === 0
		? new Error(message)
		: new NotHoistedYet(message, refinement)
}

// Every copy of a refinement goes through here. A copy of a pending one is
// registered against its source, so the fill completes it with the Alias.
function trackedRefinementCopy(
	source: common.RefinementType,
	copy: common.RefinementType,
): common.RefinementType {
	if (source.conjuncts !== null) {
		return copy
	}

	// Outside an open hoist no fill is left to complete the copy, so a
	// pending refinement reaching here is a Compiler bug.
	if (openHoists === 0) {
		refusePendingPredicate(source)
	}

	let copies = pendingRefinementCopies.get(source)

	if (copies === undefined) {
		pendingRefinementCopies.set(source, [copy])
	} else {
		copies.push(copy)
	}

	return copy
}

// The applied spelling stamped onto an instantiation, such as
// `NonEmptyList<String>`. A pending copy taken here is registered too.
export function refinementWithTypeArguments(
	refinement: common.RefinementType,
	typeArguments: Array<common.Type>,
): common.RefinementType {
	return trackedRefinementCopy(refinement, { ...refinement, typeArguments })
}

// Every copy taken of this refinement, copies of copies included. Each
// registered copy is a fresh object, so the walk needs no visited set.
export function pendingRefinementCopiesOf(
	refinement: common.RefinementType,
): Array<common.RefinementType> {
	let copies: Array<common.RefinementType> = []
	let sources: Array<common.RefinementType> = [refinement]

	while (sources.length > 0) {
		let source = sources.pop() as common.RefinementType

		for (let copy of pendingRefinementCopies.get(source) ?? []) {
			copies.push(copy)
			sources.push(copy)
		}
	}

	return copies
}

// Substitutes bound Generics in `type`. Unbound and opaque Generics stay.
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
		// A Future's slot, so a `namespace Future<infer Value>` resolves its Methods as
		// any container does.
		case "Future": {
			let valueType = applyGenericBindings(type.valueType, bindings)

			return valueType === type.valueType
				? type
				: { type: "Future", valueType }
		}
		case "Started": {
			let valueType = applyGenericBindings(type.valueType, bindings)

			return valueType === type.valueType
				? type
				: { type: "Started", valueType }
		}
		// Both slots, and an unchanged Dictionary comes back as itself.
		case "Dictionary": {
			let keyType = applyGenericBindings(type.keyType, bindings)
			let valueType = applyGenericBindings(type.valueType, bindings)

			return keyType === type.keyType && valueType === type.valueType
				? type
				: { type: "Dictionary", keyType, valueType }
		}
		// Only the base can hold a Generic. The conjuncts travel by reference, and the
		// applied spelling is substituted with the base.
		case "Refinement": {
			let base = applyGenericBindings(type.base, bindings)
			let typeArguments = type.typeArguments?.map((typeArgument) =>
				applyGenericBindings(typeArgument, bindings),
			)

			if (
				base === type.base &&
				(typeArguments === undefined ||
					typeArguments.every(
						(typeArgument, index) =>
							typeArgument === type.typeArguments?.[index],
					))
			) {
				return type
			}

			// A pending predicate is copied and registered, so a Namespace answering a
			// generic Alias' predicate can use the Alias in its signatures. See "Pending
			// refinement copies" in DEVELOPMENT.md.
			return trackedRefinementCopy(type, {
				...type,
				base,
				...(typeArguments !== undefined ? { typeArguments } : {}),
			})
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

			// A `name` may spell the Type Parameters being replaced, so it is dropped. An
			// unchanged named Union returns as itself. An `alias` substitutes along, so
			// `Optional<ItemType>` becomes `Optional<Integer>`.
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
			let aliasArguments = type.alias?.typeArguments.map((typeArgument) =>
				applyGenericBindings(typeArgument, bindings),
			)

			if (
				entries.every(
					([name, memberType]) => memberType === type.members[name],
				) &&
				(aliasArguments === undefined ||
					aliasArguments.every(
						(typeArgument, index) =>
							typeArgument === type.alias?.typeArguments[index],
					))
			) {
				return type
			}

			// The display fields follow the Union rule: `name` is dropped, `alias`
			// substitutes, and an unchanged named Record returns as itself.
			let substituted: common.RecordType = {
				type: "Record",
				members: Object.fromEntries(entries),
			}

			if (type.alias !== undefined && aliasArguments !== undefined) {
				substituted.alias = {
					name: type.alias.name,
					typeArguments: aliasArguments,
				}
			}

			return substituted
		}
		case "Case": {
			let entries = Object.entries(type.members).map(
				([name, memberType]) =>
					[name, applyGenericBindings(memberType, bindings)] as const,
			)
			let typeArguments = type.typeArguments?.map((typeArgument) =>
				applyGenericBindings(typeArgument, bindings),
			)

			let membersUnchanged = entries.every(
				([name, memberType]) => memberType === type.members[name],
			)
			let typeArgumentsUnchanged =
				typeArguments === undefined ||
				typeArguments.every(
					(typeArgument, index) =>
						typeArgument === type.typeArguments?.[index],
				)

			// A declared Case of a generic Choice is copied so its applied spelling can be
			// stamped. Any other unchanged Case returns as itself, which keeps the `===`
			// fast path in `matchTypes` cheap.
			let isDeclaredCase =
				type.choiceGenerics !== undefined &&
				type.typeArguments === undefined

			if (!isDeclaredCase && membersUnchanged && typeArgumentsUnchanged) {
				return type
			}

			let members = membersUnchanged
				? type.members
				: Object.fromEntries(entries)

			if (isDeclaredCase) {
				// The applied spelling, in declaration order. An unbound Generic stays a
				// `GenericUse`, so a later substitution can still bind it.
				return {
					type: "Case",
					choice: type.choice,
					name: type.name,
					members,
					typeArguments: type.choiceGenerics!.map(
						(generic) =>
							bindings.get(generic.name) ?? {
								type: "GenericUse",
								name: generic.name,
							},
					),
					// A fact about the declaration, kept whatever is bound.
					...(type.unitChoice === true
						? { unitChoice: true as const }
						: {}),
				}
			}

			return {
				...type,
				members,
				...(typeArguments !== undefined ? { typeArguments } : {}),
			}
		}
		case "Function":
		case "SimpleMethod":
		case "StaticMethod":
			return {
				...type,
				// Spread, so a Parameter keeps what documents it.
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

// Matches a `GenericUse` on either side. A bindable Generic's first occurrence
// binds the other side, and later ones check against that binding.
function matchGenericUse(
	generic: common.GenericUse,
	otherType: common.Type,
	context: GenericInferenceContext | null,
	checkAgainstBinding: (binding: common.Type) => boolean,
): boolean {
	if (context?.bindableNames.has(generic.name)) {
		let binding = context.bindings.get(generic.name)

		if (binding !== undefined) {
			// A Generic bound to this same-named opaque Generic is consistent. Checking
			// the binding instead would match it against itself without end.
			if (
				binding.type === "GenericUse" &&
				otherType.type === "GenericUse" &&
				binding.name === otherType.name
			) {
				return true
			}

			return checkAgainstBinding(binding)
		}

		context.bindings.set(generic.name, otherType)

		return true
	}

	// A Generic not bindable here is opaque and matches only itself, which the
	// caller has checked.
	return false
}

// A mark taken before a match attempt: the number of bindings so far.
// INVARIANT: bindings only grow during a match, and a Map iterates in insertion
// order, so an attempt's own bindings are exactly those after the mark.
function markBindings(context: GenericInferenceContext | null): number {
	return context === null ? 0 : context.bindings.size
}

// Rolls a context back to a mark after a failed attempt, whose bindings would
// otherwise decide the attempts after it. Drops them in place, so every holder
// keeps the same Map.
function restoreBindings(
	context: GenericInferenceContext | null,
	mark: number,
): void {
	if (context === null || context.bindings.size <= mark) {
		return
	}

	let bound: Array<common.GenericName> = []
	let index = 0

	for (let name of context.bindings.keys()) {
		if (index >= mark) {
			bound.push(name)
		}

		index += 1
	}

	for (let name of bound) {
		context.bindings.delete(name)
	}
}

// Members that would bind an unbound Generic are tried last, so `String` matches
// the `String` member of `Value | String` rather than binding `Value`.
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

// Whether `supplied` fills in every member `promised` lets a call leave out.
// Both lists are sorted, so this is a merge.
function defaultMembersCover(
	supplied: ReadonlyArray<string> | undefined,
	promised: ReadonlyArray<string> | undefined,
): boolean {
	if (promised === undefined || promised.length === 0) {
		return true
	}

	if (supplied === undefined) {
		return false
	}

	let index = 0

	for (let name of promised) {
		while (index < supplied.length && supplied[index] < name) {
			index++
		}

		if (index === supplied.length || supplied[index] !== name) {
			return false
		}

		index++
	}

	return true
}

// Whether `actual` can stand where `expected` is wanted: Parameter Types are
// contravariant, the return Type covariant, and labels must match exactly.
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

		// A Parameter the expected signature lets a call leave out must have a default
		// in the actual one, since the call passes `undefined` there.
		if (
			expected.parameterTypes[i].hasDefault === true &&
			actual.parameterTypes[i].hasDefault !== true
		) {
			return false
		}

		// The same rule for the members a Record Parameter's default fills in.
		if (
			!defaultMembersCover(
				actual.parameterTypes[i].defaultMembers,
				expected.parameterTypes[i].defaultMembers,
			)
		) {
			return false
		}

		if (
			!matchTypes(
				actual.parameterTypes[i].type,
				expected.parameterTypes[i].type,
				context,
				NESTED,
			)
		) {
			return false
		}
	}

	return matchTypes(expected.returnType, actual.returnType, context, NESTED)
}

// #region Type Walks, Proofs and Slots

// Whether a Type mentions a Generic anywhere. A `where` condition on a Type
// Parameter the target never mentions is refused, since nothing could bind it.
export function typeMentionsGeneric(
	type: common.Type,
	genericName: string,
): boolean {
	return typeMentionsAnyGeneric(type, new Set([genericName]))
}

// The Generic names a Type mentions, as a refinement's base names the
// Parameters a value at its position may decide.
export function genericNamesMentioned(
	type: common.Type,
): Set<common.GenericName> {
	let names = new Set<common.GenericName>()

	// A search that never succeeds, so the whole Type is walked.
	typeWalkFinds(type, (record) => {
		if (record.type === "GenericUse" && typeof record.name === "string") {
			names.add(record.name)
		}

		return false
	})

	return names
}

// The bound each of `names` gets from an applied Choice that bounds its
// position. So `X` in `SortedBox<X>` of a `choice SortedBox<Item is
// Comparable>` is bound to Comparable. `parametersOf` answers a Choice's
// declared Type Parameters, since an applied Case keeps only its Arguments.
export function choiceArgumentBounds(
	target: common.Type,
	names: ReadonlySet<common.GenericName>,
	parametersOf: (choice: string) => Array<common.GenericDeclaration>,
): Map<common.GenericName, string> {
	let bounds = new Map<common.GenericName, string>()

	for (let candidate of target.type === "UnionType"
		? target.types
		: [target]) {
		if (candidate.type !== "Case") {
			continue
		}

		let parameters = parametersOf(candidate.choice)

		for (let [index, argument] of (
			candidate.typeArguments ?? []
		).entries()) {
			let constraint = parameters[index]?.constraint

			if (
				argument.type === "GenericUse" &&
				names.has(argument.name) &&
				constraint != null
			) {
				bounds.set(argument.name, constraint)
			}
		}
	}

	return bounds
}

// Whether a Type mentions any of a set of Generic names, in one pass.
function typeMentionsAnyGeneric(
	type: common.Type,
	genericNames: ReadonlySet<common.GenericName>,
): boolean {
	return typeWalkFinds(
		type,
		(record) =>
			record.type === "GenericUse" &&
			typeof record.name === "string" &&
			genericNames.has(record.name),
	)
}

// A Function whose Protocol-bounded Type Parameters take conformance
// Parameters that only a direct call passes, so it can not be a value.
export function isBoundFunctionType(type: common.Type): boolean {
	if (
		type.type === "Function" ||
		type.type === "SimpleMethod" ||
		type.type === "StaticMethod"
	) {
		return type.generics.some((generic) => generic.constraint != null)
	}

	if (
		type.type === "OverloadedMethod" ||
		type.type === "OverloadedStaticMethod"
	) {
		return type.overloads.some((overload) =>
			overload.generics.some((generic) => generic.constraint != null),
		)
	}

	return false
}

// A Function the validator refuses wherever a value is written. An
// overloaded one names every overload at once, and a bounded one needs the
// witnesses only a direct call passes.
export function isFunctionRefusedAsValue(type: common.Type): boolean {
	return (
		type.type === "OverloadedMethod" ||
		type.type === "OverloadedStaticMethod" ||
		isBoundFunctionType(type)
	)
}

// Whether a value of this Type is or holds such a Function, in a List, a
// Dictionary, a Record, a Case or a Union. A Namespace's Methods and a
// Function's signature are no values it holds, so the walk stops there.
export function holdsFunctionRefusedAsValue(
	type: common.Type,
	visited: Set<common.Type> = new Set(),
): boolean {
	if (visited.has(type)) {
		return false
	}

	visited.add(type)

	let holds = (inner: common.Type) =>
		holdsFunctionRefusedAsValue(inner, visited)

	switch (type.type) {
		case "List":
			return holds(type.itemType)
		case "Dictionary":
			return holds(type.keyType) || holds(type.valueType)
		case "Record":
		case "Case":
			return Object.values(type.members).some(holds)
		case "UnionType":
			return type.types.some(holds)
		default:
			return isFunctionRefusedAsValue(type)
	}
}

// The Type with each Function refused as a value inside it read as a hole. The
// value around such a Function is still measured by its shape.
export function refusedFunctionsAsHoles(
	type: common.Type,
	visited: Set<common.Type> = new Set(),
): common.Type {
	if (visited.has(type) || !holdsFunctionRefusedAsValue(type)) {
		return type
	}

	visited.add(type)

	let hole = (inner: common.Type) => refusedFunctionsAsHoles(inner, visited)

	switch (type.type) {
		case "List":
			return { ...type, itemType: hole(type.itemType) }
		case "Dictionary":
			return {
				...type,
				keyType: hole(type.keyType),
				valueType: hole(type.valueType),
			}
		case "Record":
		case "Case":
			return {
				...type,
				members: Object.fromEntries(
					Object.entries(type.members).map(([name, member]) => [
						name,
						hole(member),
					]),
				),
			}
		case "UnionType":
			return { ...type, types: type.types.map(hole) }
		default:
			return { type: "Error" }
	}
}

// The value as a fit measures it: a Function refused as a value inside it is a
// hole. A mismatch reported from it names no such Function a second time.
export function measuredValue(
	value: common.typed.ExpressionNode,
): common.typed.ExpressionNode {
	// Holing keeps a Case a Case, so the Node keeps its kind.
	return holdsFunctionRefusedAsValue(value.type)
		? ({
				...value,
				type: refusedFunctionsAsHoles(value.type),
			} as common.typed.ExpressionNode)
		: value
}

// Whether a value of this Type was reported where it was written. It is the
// Error Type, or it is or holds a Function refused as a value. A check on such
// a value stands down.
export function isReportedValue(type: common.Type): boolean {
	return type.type === "Error" || holdsFunctionRefusedAsValue(type)
}

// Whether an Error Type sits anywhere in this one. It was reported where it
// came from, so a Type holding one must not be reported again.
export function typeContainsError(type: common.Type): boolean {
	return typeWalkFinds(type, (record) => record.type === "Error")
}

// Whether a checked refinement sits anywhere in this Type. The Rewriter treats
// one it is about to serialise as an internal error, since refinements erase.
export function typeContainsRefinement(type: common.Type): boolean {
	return typeWalkFinds(type, (record) => record.type === "Refinement")
}

// The key that makes two leaves one question: Namespace, Method, negation and
// Arguments, without the spelling. See "Predicate conjuncts" in DEVELOPMENT.md.
export function predicateConjunctKey(
	conjunct: common.PredicateConjunct,
): string {
	return `${conjunct.namespaceName}::${conjunct.methodName}:${
		conjunct.negated ? "!" : ""
	}${JSON.stringify(conjunct.args)}`
}

// The leaf negated, without its spelling, which named the other polarity.
export function negatedPredicateConjunct(
	conjunct: common.PredicateConjunct,
): common.PredicateConjunct {
	let { spelling: _spelling, ...leaf } = conjunct

	return { ...leaf, negated: !conjunct.negated }
}

// The keys a set of leaves proves, its own and those an ordering's law implies
// for the same Argument, where the base answered the leaf. See "Predicate
// conjuncts" in DEVELOPMENT.md.
let impliedKeyMemos = new WeakMap<
	Array<common.PredicateConjunct>,
	Map<string, ReadonlySet<string>>
>()

export function impliedConjunctKeys(
	conjuncts: Array<common.PredicateConjunct>,
	base: common.Type,
): ReadonlySet<string> {
	let tag = refinableBaseTag(base)
	let byBase = impliedKeyMemos.get(conjuncts)
	let remembered = byBase?.get(tag)

	if (remembered !== undefined) {
		return remembered
	}

	let keys = new Set<string>()

	for (let conjunct of conjuncts) {
		keys.add(predicateConjunctKey(conjunct))

		if (!answersForBase(conjunct, tag)) {
			continue
		}

		for (let implied of excludedByConjunct(conjunct)) {
			keys.add(predicateConjunctKey(implied))
		}
	}

	for (let left of conjuncts) {
		if (!answersForBase(left, tag)) {
			continue
		}

		for (let remaining of leftByExclusions(left, conjuncts)) {
			keys.add(predicateConjunctKey(remaining))
		}
	}

	if (byBase === undefined) {
		byBase = new Map()
		impliedKeyMemos.set(conjuncts, byBase)
	}

	byBase.set(tag, keys)

	return keys
}

// Whether the base's own ordering answered a leaf: the base's Namespace, or the
// covering `Number`.
export function answersForBase(
	conjunct: common.PredicateConjunct,
	tag: string,
): boolean {
	return namespaceAnswersForBase(conjunct.namespaceName, tag)
}

// The same question of a Namespace name, for the Enricher reading a body before
// it has a conjunct.
export function namespaceAnswersForBase(
	namespaceName: string,
	tag: string,
): boolean {
	return namespaceName === tag || namespaceName === "Number"
}

// The tag of the Type a refinement is written on, through nested refinements
// and generic Aliases.
export function refinableBaseTag(type: common.Type): string {
	let current = type

	while (current.type === "Refinement" || current.type === "GenericAlias") {
		current =
			current.type === "Refinement" ? current.base : current.aliasedType
	}

	return current.type
}

// The two comparisons one leaf rules out, over its own Argument.
function excludedByConjunct(
	conjunct: common.PredicateConjunct,
): Array<common.PredicateConjunct> {
	if (conjunct.negated) {
		return []
	}

	if (conjunct.args.length === 1) {
		let others = COMPARISON_TRIO[conjunct.methodName]

		return others === undefined
			? []
			: others.map((methodName) =>
					comparisonLeaf(
						conjunct,
						methodName,
						conjunct.args[0]!,
						true,
					),
				)
	}

	if (conjunct.methodName === "isBetween" && conjunct.args.length === 2) {
		let first = boundArgument(conjunct.args[0]!)
		let second = boundArgument(conjunct.args[1]!)

		if (first === null || second === null) {
			return []
		}

		// The bounds name one range in either order, as the standard library reads them.
		let exchanged =
			first.numerator * second.denominator >
			second.numerator * first.denominator
		let lowest = exchanged ? conjunct.args[1]! : conjunct.args[0]!
		let highest = exchanged ? conjunct.args[0]! : conjunct.args[1]!

		return [
			comparisonLeaf(conjunct, "isLessThan", lowest, true),
			comparisonLeaf(conjunct, "isGreaterThan", highest, true),
		]
	}

	return []
}

// The comparison two exclusions over one bound leave standing: not equal to
// and not less than zero prove greater than zero.
function leftByExclusions(
	conjunct: common.PredicateConjunct,
	conjuncts: Array<common.PredicateConjunct>,
): Array<common.PredicateConjunct> {
	let others = conjunct.negated
		? COMPARISON_TRIO[conjunct.methodName]
		: undefined

	if (others === undefined || conjunct.args.length !== 1) {
		return []
	}

	let argument = conjunct.args[0]!
	let standing = others.filter(
		(methodName) =>
			!conjuncts.some(
				(other) =>
					other.negated &&
					other.namespaceName === conjunct.namespaceName &&
					other.methodName === methodName &&
					other.args.length === 1 &&
					other.args[0] === argument,
			),
	)

	return standing.length === 1
		? [comparisonLeaf(conjunct, standing[0]!, argument, false)]
		: []
}

// The three comparisons over one bound, each mapped to the other two.
const COMPARISON_TRIO: Record<string, Array<string>> = {
	is: ["isLessThan", "isGreaterThan"],
	isLessThan: ["is", "isGreaterThan"],
	isGreaterThan: ["is", "isLessThan"],
}

function comparisonLeaf(
	source: common.PredicateConjunct,
	methodName: string,
	argument: string | boolean,
	negated: boolean,
): common.PredicateConjunct {
	return {
		namespaceName: source.namespaceName,
		methodName,
		args: [argument],
		negated,
	}
}

// A bound as an exact pair with the sign on the numerator, for comparing.
// `predicateEval.ts` imports this module, so its reader can not be borrowed.
function boundArgument(
	scalar: string | boolean,
): { numerator: bigint; denominator: bigint } | null {
	if (typeof scalar !== "string") {
		return null
	}

	let parts = /^(-?\d+)(?:\/(-?\d+))?$/.exec(scalar)

	if (parts === null) {
		return null
	}

	let numerator = BigInt(parts[1]!)
	let denominator = parts[2] === undefined ? 1n : BigInt(parts[2])

	if (denominator === 0n) {
		return null
	}

	return denominator < 0n
		? { numerator: -numerator, denominator: -denominator }
		: { numerator, denominator }
}

// A refinement's conjuncts, refused while still null, as they are while the
// Namespace answering the predicate waits to hoist.
export function provenConjuncts(
	refinement: common.RefinementType,
): Array<common.PredicateConjunct> {
	if (refinement.conjuncts === null) {
		refusePendingPredicate(refinement)
	}

	return refinement.conjuncts
}

// The canonical conjunct set: sorted by key, duplicates dropped, so one
// predicate is one set however it was written.
export function canonicalPredicateConjuncts(
	conjuncts: Array<common.PredicateConjunct>,
): Array<common.PredicateConjunct> {
	let byKey = new Map<string, common.PredicateConjunct>()

	for (let conjunct of conjuncts) {
		let key = predicateConjunctKey(conjunct)

		if (!byKey.has(key)) {
			byKey.set(key, conjunct)
		}
	}

	return [...byKey.entries()]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([, conjunct]) => conjunct)
}

// Whether an undecided slot sits anywhere in this Type. See "Filling undecided
// slots" in DEVELOPMENT.md.
export function typeContainsUnknown(type: common.Type): boolean {
	switch (type.type) {
		case "Unknown":
			return true
		case "List":
			return typeContainsUnknown(type.itemType)
		// A Future's or a Started's slot, which no Program can leave open itself.
		case "Future":
		case "Started":
			return typeContainsUnknown(type.valueType)
		// Either slot. A `GenericDictionary`'s Unknowns are declared defaults.
		case "Dictionary":
			return (
				typeContainsUnknown(type.keyType) ||
				typeContainsUnknown(type.valueType)
			)
		case "Record":
			return Object.values(type.members).some(typeContainsUnknown)
		case "UnionType":
			return type.types.some(typeContainsUnknown)
		// A refinement decides nothing its base has not.
		case "Refinement":
			return typeContainsUnknown(type.base)
		default:
			return false
	}
}

// Whether a written Type decides an undecided slot: anything but a blank,
// unless it holds an Error. See "Filling undecided slots" in DEVELOPMENT.md.
export function decidesAnUndecidedSlot(written: common.Type): boolean {
	return written.type !== "Unknown" && !typeContainsError(written)
}

// The Type with every proof taken off it, or itself where it holds none. See
// "Display spellings" in DEVELOPMENT.md.
function withoutRefinements(type: common.Type): common.Type {
	switch (type.type) {
		case "Refinement":
			return withoutRefinements(type.base)
		case "List": {
			let itemType = withoutRefinements(type.itemType)

			return itemType === type.itemType
				? type
				: { type: "List", itemType }
		}
		case "Future": {
			let valueType = withoutRefinements(type.valueType)

			return valueType === type.valueType
				? type
				: { type: "Future", valueType }
		}
		case "Started": {
			let valueType = withoutRefinements(type.valueType)

			return valueType === type.valueType
				? type
				: { type: "Started", valueType }
		}
		case "Dictionary": {
			let keyType = withoutRefinements(type.keyType)
			let valueType = withoutRefinements(type.valueType)

			return keyType === type.keyType && valueType === type.valueType
				? type
				: { type: "Dictionary", keyType, valueType }
		}
		// A rebuilt Record drops its display spelling: it is no longer the Alias.
		case "Record": {
			let members: Record<string, common.Type> = {}
			let stripped = false

			for (let [name, memberType] of Object.entries(type.members)) {
				members[name] = withoutRefinements(memberType)
				stripped ||= members[name] !== memberType
			}

			return stripped ? { type: "Record", members } : type
		}
		// The name and the alias go with the arm they described.
		case "UnionType": {
			let types = type.types.map(withoutRefinements)

			return types.some((arm, index) => arm !== type.types[index])
				? { type: "UnionType", types }
				: type
		}
		default:
			return type
	}
}

// The Type with every Record's display spelling taken off, for the runtime and
// the embedding boundary. A Union keeps its own. See "Display spellings" in
// DEVELOPMENT.md.
export function withoutRecordNames(type: common.Type): common.Type {
	let visiting = new Set<common.Type>()

	let strip = (type: common.Type): common.Type => {
		if (visiting.has(type)) {
			return type
		}

		visiting.add(type)

		try {
			switch (type.type) {
				case "Record":
				case "Case": {
					let members: Record<string, common.Type> = {}
					let changed = false

					for (let [name, memberType] of Object.entries(
						type.members,
					)) {
						members[name] = strip(memberType)
						changed ||= members[name] !== memberType
					}

					if (type.type === "Case") {
						let typeArguments = strippedArguments(
							type.typeArguments,
							strip,
						)

						return changed || typeArguments !== type.typeArguments
							? {
									...type,
									members,
									...(typeArguments === undefined
										? {}
										: { typeArguments }),
								}
							: type
					}

					return changed ||
						type.name !== undefined ||
						type.alias !== undefined
						? { type: "Record", members }
						: type
				}
				case "List": {
					let itemType = strip(type.itemType)

					return itemType === type.itemType
						? type
						: { type: "List", itemType }
				}
				case "Future": {
					let valueType = strip(type.valueType)

					return valueType === type.valueType
						? type
						: { type: "Future", valueType }
				}
				case "Started": {
					let valueType = strip(type.valueType)

					return valueType === type.valueType
						? type
						: { type: "Started", valueType }
				}
				case "Dictionary": {
					let keyType = strip(type.keyType)
					let valueType = strip(type.valueType)

					return keyType === type.keyType &&
						valueType === type.valueType
						? type
						: { type: "Dictionary", keyType, valueType }
				}
				// An applied spelling's Type Arguments are stripped too, since they are
				// printed.
				case "UnionType": {
					let types = type.types.map((arm) =>
						arm.type === "GenericUse" ? arm : strip(arm),
					)
					let alias = strippedArguments(
						type.alias?.typeArguments,
						strip,
					)

					if (
						types.every(
							(arm, index) => arm === type.types[index],
						) &&
						alias === type.alias?.typeArguments
					) {
						return type
					}

					return {
						...type,
						types,
						...(type.alias === undefined || alias === undefined
							? {}
							: {
									alias: {
										...type.alias,
										typeArguments: alias,
									},
								}),
					}
				}
				case "Refinement": {
					let base = strip(type.base)
					let typeArguments = strippedArguments(
						type.typeArguments,
						strip,
					)

					return base === type.base &&
						typeArguments === type.typeArguments
						? type
						: {
								...type,
								base,
								...(typeArguments === undefined
									? {}
									: { typeArguments }),
							}
				}
				// A Function Type is data in a descriptor like any other.
				case "Function":
				case "SimpleMethod":
				case "StaticMethod": {
					let signature = strippedSignature(type, strip)

					return signature === type ? type : { ...type, ...signature }
				}
				// An Overload set, which the embedding boundary prints.
				case "OverloadedMethod":
				case "OverloadedStaticMethod": {
					let overloads = type.overloads.map((overload) =>
						strippedSignature(overload, strip),
					)

					return overloads.every(
						(overload, index) => overload === type.overloads[index],
					)
						? type
						: { ...type, overloads }
				}
				default:
					return type
			}
		} finally {
			visiting.delete(type)
		}
	}

	return strip(type)
}

// The same for a signature, which has no `type` field, for `printSignature`.
export function withoutRecordNamesInSignature(
	signature: common.BaseFunction,
): common.BaseFunction {
	return strippedSignature(signature, withoutRecordNames)
}

// Type Arguments stripped, or the same list where nothing changed.
function strippedArguments<Argument extends common.Type>(
	typeArguments: Array<Argument> | undefined,
	strip: (type: common.Type) => common.Type,
): Array<Argument> | undefined {
	if (typeArguments === undefined) {
		return undefined
	}

	let stripped = typeArguments.map(
		(typeArgument) => strip(typeArgument) as Argument,
	)

	return stripped.every(
		(typeArgument, index) => typeArgument === typeArguments[index],
	)
		? typeArguments
		: stripped
}

function strippedSignature<Signature extends common.BaseFunction>(
	signature: Signature,
	strip: (type: common.Type) => common.Type,
): Signature {
	let parameterTypes = signature.parameterTypes.map((parameter) => {
		let type = strip(parameter.type)

		return type === parameter.type ? parameter : { ...parameter, type }
	})
	let returnType = strip(signature.returnType)

	return parameterTypes.every(
		(parameter, index) => parameter === signature.parameterTypes[index],
	) && returnType === signature.returnType
		? signature
		: { ...signature, parameterTypes, returnType }
}

// `stored` with every Unknown slot `value` answers filled in, or `stored` itself.
// See "Filling undecided slots" in DEVELOPMENT.md.
export function resolveUnknownSlots(
	stored: common.Type,
	value: common.Type,
): common.Type {
	// The Types being walked, a guard for a Type naming itself.
	let visiting = new Set<common.Type>()

	let resolve = (stored: common.Type, written: common.Type): common.Type => {
		if (stored === written || visiting.has(stored)) {
			return stored
		}

		// A decision never carries a refinement: a slot holds many values, and a
		// refinement proves something of one.
		if (stored.type === "Unknown") {
			return decidesAnUndecidedSlot(written)
				? withoutRefinements(written)
				: stored
		}

		// A refinement over the container is looked through, and its proof dropped.
		let value = written

		while (value.type === "Refinement") {
			value = value.base
		}

		// A written Union is resolved member by member and merged by
		// `agreedDecisions`, before the visiting guard, since each member is smaller.
		if (value.type === "UnionType" && stored.type !== "UnionType") {
			return agreedDecisions(
				stored,
				value.types.map((member) => resolve(stored, member)),
			)
		}

		visiting.add(stored)

		try {
			if (stored.type === "List" && value.type === "List") {
				let itemType = resolve(stored.itemType, value.itemType)

				return itemType === stored.itemType
					? stored
					: { type: "List", itemType }
			}

			// One slot each, as a List's item Type.
			if (stored.type === "Future" && value.type === "Future") {
				let valueType = resolve(stored.valueType, value.valueType)

				return valueType === stored.valueType
					? stored
					: { type: "Future", valueType }
			}

			if (stored.type === "Started" && value.type === "Started") {
				let valueType = resolve(stored.valueType, value.valueType)

				return valueType === stored.valueType
					? stored
					: { type: "Started", valueType }
			}

			// Each slot is filled independently.
			if (stored.type === "Dictionary" && value.type === "Dictionary") {
				let keyType = resolve(stored.keyType, value.keyType)
				let valueType = resolve(stored.valueType, value.valueType)

				return keyType === stored.keyType &&
					valueType === stored.valueType
					? stored
					: { type: "Dictionary", keyType, valueType }
			}

			if (stored.type === "Record" && value.type === "Record") {
				let members: Record<string, common.Type> = {}
				let pinned = false

				for (let [name, memberType] of Object.entries(stored.members)) {
					let valueMember = value.members[name]
					let resolved =
						valueMember === undefined
							? memberType
							: resolve(memberType, valueMember)

					members[name] = resolved
					pinned ||= resolved !== memberType
				}

				return pinned ? { type: "Record", members } : stored
			}

			if (stored.type === "UnionType" && value.type === "UnionType") {
				// Arms pair by shape, only where exactly one written arm has it.
				let types = stored.types.map((arm) => {
					let candidates = value.types.filter(
						(candidate) => candidate.type === arm.type,
					)

					return candidates.length === 1
						? resolve(arm, candidates[0])
						: arm
				})

				// The name and the alias go with the arm they described.
				return types.some((arm, index) => arm !== stored.types[index])
					? { type: "UnionType", types }
					: stored
			}

			return stored
		} finally {
			visiting.delete(stored)
		}
	}

	return resolve(stored, value)
}

// What several readings of `stored` agree its blanks are, slot by slot. One
// answer decides a slot, and differing answers leave it open.
function agreedDecisions(
	stored: common.Type,
	candidates: Array<common.Type>,
): common.Type {
	if (stored.type === "Unknown") {
		let [first, ...rest] = candidates.filter(
			(candidate) => candidate.type !== "Unknown",
		)

		if (first === undefined) {
			return stored
		}

		return rest.every(
			(other) => matchesType(first, other) && matchesType(other, first),
		)
			? first
			: stored
	}

	if (stored.type === "List") {
		let itemType = agreedDecisions(
			stored.itemType,
			candidates.map((candidate) =>
				candidate.type === "List"
					? candidate.itemType
					: stored.itemType,
			),
		)

		return itemType === stored.itemType
			? stored
			: { type: "List", itemType }
	}

	if (stored.type === "Future" || stored.type === "Started") {
		let shape = stored.type
		let valueType = agreedDecisions(
			stored.valueType,
			candidates.map((candidate) =>
				candidate.type === shape
					? candidate.valueType
					: stored.valueType,
			),
		)

		if (valueType === stored.valueType) {
			return stored
		}

		return shape === "Future"
			? { type: "Future", valueType }
			: { type: "Started", valueType }
	}

	if (stored.type === "Dictionary") {
		let keyType = agreedDecisions(
			stored.keyType,
			candidates.map((candidate) =>
				candidate.type === "Dictionary"
					? candidate.keyType
					: stored.keyType,
			),
		)
		let valueType = agreedDecisions(
			stored.valueType,
			candidates.map((candidate) =>
				candidate.type === "Dictionary"
					? candidate.valueType
					: stored.valueType,
			),
		)

		return keyType === stored.keyType && valueType === stored.valueType
			? stored
			: { type: "Dictionary", keyType, valueType }
	}

	// Member by member, so `{ evens = [], odds = [] }` is decided one member per
	// branch.
	if (stored.type === "Record") {
		let members: Record<string, common.Type> = {}
		let pinned = false

		for (let [name, memberType] of Object.entries(stored.members)) {
			let resolved = agreedDecisions(
				memberType,
				candidates.map((candidate) =>
					candidate.type === "Record" &&
					Object.hasOwn(candidate.members, name)
						? candidate.members[name]
						: memberType,
				),
			)

			members[name] = resolved
			pinned ||= resolved !== memberType
		}

		return pinned ? { type: "Record", members } : stored
	}

	// Arm by arm and by position, since every candidate came from the same
	// `stored`.
	if (stored.type === "UnionType") {
		let arms = stored.types
		let types = arms.map((arm, index) =>
			agreedDecisions(
				arm,
				candidates.map((candidate) =>
					candidate.type === "UnionType" &&
					candidate.types.length === arms.length
						? candidate.types[index]
						: arm,
				),
			),
		)

		return types.some((arm, index) => arm !== arms[index])
			? { type: "UnionType", types }
			: stored
	}

	return stored
}

// #endregion

// #region Protocol Conformance

// The Method fulfilling a requirement, with its emitted name: a Simple Method,
// or the first matching Overload, as a call resolves. Staticness must agree.
export function findFulfillingMethod(
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

// Like `flattenUnionMembers`, but a named nested Union, such as a Choice or an
// applied `Optional<X>`, stays whole, so its name is displayed.
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
	return matchTypes(lhs, rhs, null, OUTERMOST)
}

// Whether every member of `part` is one `whole` declares, at a Type that member
// admits: what a `with` right-hand side must be. `context` lets an inferring
// caller ask.
export function isPartialOf(
	whole: common.RecordType,
	part: common.RecordType,
	context: GenericInferenceContext | null = null,
): boolean {
	for (let [partName, partMemberType] of Object.entries(part.members)) {
		// `Object.hasOwn`, since a member may share a name with `Object.prototype`.
		if (
			!Object.hasOwn(whole.members, partName) ||
			!matchTypes(
				whole.members[partName],
				partMemberType,
				context,
				NESTED,
			)
		) {
			return false
		}
	}

	return true
}

// The Type a Record Literal with path keys has once merged into its default: a
// member a path key wrote stands for the whole member. Null where it wrote none,
// or where the merge does not hold and the position refuses it.
export function mergedRecordType(
	into: common.Type | common.GenericUse,
	nesting: common.DefaultNesting | undefined,
	value: common.typed.ExpressionNode | null | undefined,
	context: GenericInferenceContext | null = null,
): common.RecordType | null {
	if (
		into.type !== "Record" ||
		value == null ||
		value.nodeType !== "RecordValue" ||
		!Object.values(value.members).some(isMergedLevel)
	) {
		return null
	}

	return mergedLevelType(into, nesting ?? {}, value, context)
}

// A level a path key built, which is a partial of the member it stands
// for. Written as a guard rather than read inline so that "was this written as a
// path" is asked in one spelling everywhere.
export function isMergedLevel(
	value: common.typed.ExpressionNode,
): value is common.typed.RecordValueNode {
	return value.nodeType === "RecordValue" && value.merged === true
}

function mergedLevelType(
	into: common.RecordType,
	nesting: common.DefaultNesting,
	value: common.typed.RecordValueNode,
	context: GenericInferenceContext | null,
): common.RecordType | null {
	let members: Record<string, common.Type> = {}

	for (let [name, member] of Object.entries(value.members)) {
		if (!isMergedLevel(member)) {
			members[name] = member.type

			continue
		}

		// `Object.hasOwn`, since a member may share a name with `Object.prototype`.
		if (
			!Object.hasOwn(into.members, name) ||
			!Object.hasOwn(nesting, name)
		) {
			return null
		}

		let declaredType = into.members[name]!

		if (declaredType.type !== "Record") {
			return null
		}

		let inner = mergedLevelType(
			declaredType,
			nesting[name]!,
			member,
			context,
		)

		// The level must be a partial of the member it merges into. The default fills
		// in what it leaves out.
		if (inner === null || !isPartialOf(declaredType, inner, context)) {
			return null
		}

		members[name] = declaredType
	}

	return { type: "Record", members }
}

// Whether `member` says nothing `existing` does not cover, the order a Union
// dedupes by. Where two members accept each other, the one spelling more out
// wins, so `[[], [1]]` builds `List<List<Integer>>`, not `List<List<Unknown>>`.
function subsumesForUnion(existing: common.Type, member: common.Type): boolean {
	if (!matchesType(existing, member)) {
		return false
	}

	return !(isLessSpecific(existing, member) && matchesType(member, existing))
}

// Whether `left` says strictly less about the same shape than `right`: an
// Unknown where `right` names a Type. No other difference counts.
function isLessSpecific(left: common.Type, right: common.Type): boolean {
	if (left.type === "Unknown") {
		return right.type !== "Unknown"
	}

	if (left.type === "List" && right.type === "List") {
		return isLessSpecific(left.itemType, right.itemType)
	}

	if (
		(left.type === "Future" && right.type === "Future") ||
		(left.type === "Started" && right.type === "Started")
	) {
		return isLessSpecific(left.valueType, right.valueType)
	}

	// One slot saying less is enough.
	if (left.type === "Dictionary" && right.type === "Dictionary") {
		return (
			isLessSpecific(left.keyType, right.keyType) ||
			isLessSpecific(left.valueType, right.valueType)
		)
	}

	return false
}

// The Matcher without the members no candidate of its shape declares, at any
// depth. Records are open, so a value may still carry such a member, and the
// arm's reach is judged on the rest. See "Runtime overlap" in
// packages/compiler/src/validator/DEVELOPMENT.md.
export function withoutUndeclaredMembers(
	matcher: common.Type,
	candidates: Array<common.Type>,
): common.Type {
	if (matcher.type !== "Record" && matcher.type !== "Case") {
		return matcher
	}

	let shaped = candidates
		.flatMap((candidate) =>
			candidate.type === "UnionType"
				? flattenUnionMembers(candidate)
				: [candidate],
		)
		.filter(
			(candidate): candidate is common.RecordType | common.CaseType =>
				matcher.type === "Record"
					? candidate.type === "Record"
					: candidate.type === "Case" &&
						candidate.choice === matcher.choice &&
						candidate.name === matcher.name,
		)

	if (shaped.length === 0) {
		return matcher
	}

	let members: Record<string, common.Type> = {}

	for (let [name, memberMatcher] of Object.entries(matcher.members)) {
		let declared = shaped.flatMap((candidate) =>
			Object.hasOwn(candidate.members, name)
				? [candidate.members[name]!]
				: [],
		)

		if (declared.length > 0) {
			members[name] = withoutUndeclaredMembers(memberMatcher, declared)
		}
	}

	return { ...matcher, members }
}

// Builds a Union from a list of members. Members that subsume one another
// collapse, so `Integer` beside `Number` is `Number`. Anonymous nested Unions are
// flattened in, and named ones stay whole.
export function buildUnion(members: Array<common.Type>): common.Type {
	let distinct: Array<common.Type> = []

	let collect = (member: common.Type) => {
		if (
			member.type === "UnionType" &&
			member.name === undefined &&
			member.alias === undefined
		) {
			for (let nestedMember of member.types) {
				collect(nestedMember)
			}

			return
		}

		if (distinct.some((existing) => subsumesForUnion(existing, member))) {
			return
		}

		distinct = distinct.filter(
			(existing) => !subsumesForUnion(member, existing),
		)
		distinct.push(member)
	}

	for (let member of members) {
		collect(member)
	}

	if (distinct.length === 1) {
		return distinct[0]
	}

	return { type: "UnionType", types: distinct }
}

// A generic Case with each Type Parameter its prefix leaves open a blank, where
// nothing decides them: the Choice's, or a generic Alias's. Its payload is
// still asked for every member.
export function caseWithBlanks(
	declared: common.CaseType,
	open: Array<common.GenericDeclaration>,
): common.CaseType {
	let { choiceGenerics = [], ...instantiated } = declared
	let blanks: GenericBindings = new Map(
		[...choiceGenerics, ...open].map((generic) => [
			generic.name,
			{ type: "Unknown" },
		]),
	)

	return applyGenericBindings(instantiated, blanks) as common.CaseType
}

function isError(type: common.Type): boolean {
	return type.type === "Error"
}

// A Type without the holes `buildWrittenUnion` left in a Union, which is what
// the Union is measured and called by.
export function withoutHoles(type: common.Type): common.Type {
	return type.type === "UnionType" && type.types.some(isError)
		? buildUnion(type.types.filter((member) => !isError(member)))
		: type
}

function measuredWithoutHoles(lhs: common.Type, rhs: common.Type): common.Type {
	return lhs.type === "GenericUse" ? rhs : withoutHoles(rhs)
}

// A written Union. A member that did not resolve stays beside the known ones
// as a hole, since `buildUnion` would keep or drop it by the written order.
export function buildWrittenUnion(members: Array<common.Type>): common.Type {
	let known = members.filter((member) => member.type !== "Error")

	if (known.length === members.length || known.length === 0) {
		return known.length === 0 ? { type: "Error" } : buildUnion(known)
	}

	let union = buildUnion(known)

	return {
		type: "UnionType",
		types: [
			...(union.type === "UnionType" ? union.types : [union]),
			{
				type: "Error",
			},
		],
	}
}

// The deduped member list `buildUnion` would make, for a caller that finishes
// the Union itself.
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
			if (
				distinct.some((existing) => subsumesForUnion(existing, member))
			) {
				continue
			}

			distinct = distinct.filter(
				(existing) => !subsumesForUnion(member, existing),
			)
			distinct.push(member)
		}
	}

	return distinct
}

// `matchesType` with a context: a bindable Generic binds on its first occurrence,
// and later ones are checked. Bindings accumulate in `context.bindings`.
export function matchesTypeWithBindings(
	lhs: common.Type,
	rhs: common.Type,
	context: GenericInferenceContext,
): boolean {
	return matchTypes(lhs, rhs, context, OUTERMOST)
}

// The Case pairs being compared, by `lhs` identity, the coinductive guard in
// `matchTypes`. Empty between top-level matches.
const activeCasePairs = new Map<common.CaseType, Set<common.CaseType>>()

// The Generic names a binding mentions, remembered per Type object. No edit in
// place adds a name, so a remembered answer stays true.
const bindingMentionsMemo = new WeakMap<common.Type, Set<common.GenericName>>()

function mentionedGenericNames(binding: common.Type): Set<common.GenericName> {
	let remembered = bindingMentionsMemo.get(binding)

	if (remembered === undefined) {
		remembered = genericNamesMentioned(binding)
		bindingMentionsMemo.set(binding, remembered)
	}

	return remembered
}

// Whether a Parameter's bindings lead back to itself, the occurs check over the
// whole binding graph. See "Type Parameters" in DEVELOPMENT.md.
function bindingCyclesBackTo(
	name: common.GenericName,
	context: GenericInferenceContext,
): boolean {
	// Nearly every binding mentions no Generic, which the memo answers at once.
	let held = context.bindings.get(name)

	if (held === undefined || mentionedGenericNames(held).size === 0) {
		return false
	}

	let seen = new Set<common.GenericName>([name])
	let pending: Array<common.GenericName> = [name]

	while (pending.length > 0) {
		let binding = context.bindings.get(pending.pop()!)

		if (binding === undefined) {
			continue
		}

		for (let mentioned of mentionedGenericNames(binding)) {
			if (mentioned === name) {
				return true
			}

			if (!context.bindableNames.has(mentioned) || seen.has(mentioned)) {
				continue
			}

			seen.add(mentioned)
			pending.push(mentioned)
		}
	}

	return false
}

// Whether a Generic is still open to binding: bindable, and not bound to a Type
// that leads back to itself. See "Type Parameters" in DEVELOPMENT.md.
function isOpenBindable(
	name: string,
	context: GenericInferenceContext | null,
): boolean {
	if (!context?.bindableNames.has(name)) {
		return false
	}

	return !(context.bindings.has(name) && bindingCyclesBackTo(name, context))
}

// Whether a Type Parameter is bound to a refinement, bound from inside a Type
// or applied by hand. Comparisons then go against that proof.
function refinementBoundTo(
	type: common.Type,
	context: GenericInferenceContext | null,
): boolean {
	if (type.type !== "GenericUse" || !isOpenBindable(type.name, context)) {
		return false
	}

	return context?.bindings.get(type.name)?.type === "Refinement"
}

// Where the comparison stands: the whole of a position, or inside a Type. Only
// the refinement rule reads it. See "Refinements" in DEVELOPMENT.md.
type MatchDepth = "outermost" | "nested"

const OUTERMOST: MatchDepth = "outermost"

const NESTED: MatchDepth = "nested"

// Notes each unbound Type Parameter on the side an Error met, anywhere in it.
// See "Type Parameters" in DEVELOPMENT.md.
function noteGenericsMetByError(
	lhs: common.Type,
	rhs: common.Type,
	context: GenericInferenceContext | null,
): void {
	if (context === null) {
		return
	}

	for (let name of mentionedGenericNames(lhs.type === "Error" ? rhs : lhs)) {
		if (context.bindableNames.has(name) && !context.bindings.has(name)) {
			context.metError ??= new Set()
			context.metError.add(name)
		}
	}
}

// Binds each Type Parameter an Error met and nothing else bound to the Error,
// once every Argument that could bind it was matched.
export function settleErrorBindings(context: GenericInferenceContext): void {
	for (let name of context.metError ?? []) {
		if (!context.bindings.has(name)) {
			context.bindings.set(name, { type: "Error" })
		}
	}
}

// The bindings a Function literal Argument is typed under. A Type Parameter an
// Error met and nothing bound yet reads as the Error.
function bindingsWithErrorFallback(
	context: GenericInferenceContext,
): GenericBindings {
	let fallback = new Map(context.bindings)

	for (let name of context.metError ?? []) {
		if (!fallback.has(name)) {
			fallback.set(name, { type: "Error" })
		}
	}

	return fallback
}

function matchTypes(
	lhs: common.Type,
	rhs: common.Type,
	context: GenericInferenceContext | null,
	depth: MatchDepth,
): boolean {
	// An Error matches anything both ways, so one mistake does not cascade.
	if (lhs.type === "Error" || rhs.type === "Error") {
		noteGenericsMetByError(lhs, rhs, context)

		return true
	}

	// A written Union holding a hole fits where its known members fit. A Type
	// Parameter binds it whole. See "Unions" in DEVELOPMENT.md.
	rhs = measuredWithoutHoles(lhs, rhs)

	// An actual refinement flows into whatever its base does, before Generic
	// binding, so an outermost Type Parameter binds the base. Skipped nested, against
	// a Union, and for a Parameter bound to a refinement. See "Refinements" in
	// DEVELOPMENT.md.
	if (
		rhs.type === "Refinement" &&
		lhs.type !== "Refinement" &&
		lhs.type !== "UnionType" &&
		!(
			depth === NESTED &&
			lhs.type === "GenericUse" &&
			isOpenBindable(lhs.name, context)
		) &&
		!refinementBoundTo(lhs, context)
	) {
		return matchTypes(lhs, rhs.base, context, depth)
	}

	// An expected refinement needs a refinement whose proven keys contain its own.
	// A bound Generic on the actual side is compared through its binding.
	if (
		lhs.type === "Refinement" &&
		!(
			rhs.type === "GenericUse" &&
			context?.bindings.has(rhs.name) === true &&
			isOpenBindable(rhs.name, context)
		)
	) {
		if (rhs.type !== "Refinement") {
			return false
		}

		let proven = impliedConjunctKeys(provenConjuncts(rhs), rhs.base)

		return (
			matchTypes(lhs.base, rhs.base, context, depth) &&
			provenConjuncts(lhs).every((conjunct) =>
				proven.has(predicateConjunctKey(conjunct)),
			)
		)
	}

	// Two same-named Generics match where neither is open. An open one must reach
	// `matchGenericUse` to record its binding.
	if (
		lhs.type === "GenericUse" &&
		rhs.type === "GenericUse" &&
		lhs.name === rhs.name &&
		!isOpenBindable(lhs.name, context) &&
		!isOpenBindable(rhs.name, context)
	) {
		return true
	}

	// An open Generic binds on either side, since compared signatures flip sides.
	if (lhs.type === "GenericUse" && isOpenBindable(lhs.name, context)) {
		return matchGenericUse(lhs, rhs, context, (binding) =>
			matchTypes(binding, rhs, context, depth),
		)
	}

	if (rhs.type === "GenericUse" && isOpenBindable(rhs.name, context)) {
		return matchGenericUse(rhs, lhs, context, (binding) =>
			matchTypes(lhs, binding, context, depth),
		)
	}

	// An expected opaque Generic accepts only itself. As the actual Type it falls
	// through, so an expected Union can accept it as a member.
	if (lhs.type === "GenericUse") {
		return false
	}

	// An `Unknown` expected Type is the Compiler's recovery, which no author can
	// write, so it accepts everything. A container's `Unknown` slot has its own rules.
	if (lhs.type === "Unknown") {
		return true
	}

	// A bare `List` accepts every List, but does not satisfy a decided one.
	if (
		lhs.type === "GenericList" &&
		(rhs.type === "GenericList" || rhs.type === "List")
	) {
		return true
	}

	if (lhs.type === "List" && rhs.type === "List") {
		// An undecided item Type may be read as bottom, but a write must decide it
		// first. See "Containers and slots" in DEVELOPMENT.md.
		if (
			lhs.itemType.type === "Unknown" &&
			decidesAnUndecidedSlot(rhs.itemType)
		) {
			return false
		}

		// An empty List Literal fits any List.
		if (rhs.itemType.type === "Unknown") {
			return true
		}

		return matchTypes(lhs.itemType, rhs.itemType, context, NESTED)
	}

	// A bare `Dictionary` accepts every Dictionary.
	if (
		lhs.type === "GenericDictionary" &&
		(rhs.type === "GenericDictionary" || rhs.type === "Dictionary")
	) {
		return true
	}

	if (lhs.type === "Dictionary" && rhs.type === "Dictionary") {
		// The write rule per slot: an undecided slot refuses a value that decides it.
		if (
			(lhs.keyType.type === "Unknown" &&
				decidesAnUndecidedSlot(rhs.keyType)) ||
			(lhs.valueType.type === "Unknown" &&
				decidesAnUndecidedSlot(rhs.valueType))
		) {
			return false
		}

		// The empty-List rule per slot, so `Dictionary<Unknown, Integer>` fits
		// `Dictionary<String, Integer>` and not `Dictionary<String, String>`.
		let keysMatch =
			rhs.keyType.type === "Unknown" ||
			matchTypes(lhs.keyType, rhs.keyType, context, NESTED)

		return (
			keysMatch &&
			(rhs.valueType.type === "Unknown" ||
				matchTypes(lhs.valueType, rhs.valueType, context, NESTED))
		)
	}

	// Covariant, since nothing writes into a Future.
	if (lhs.type === "Future" && rhs.type === "Future") {
		return matchTypes(lhs.valueType, rhs.valueType, context, NESTED)
	}

	if (lhs.type === "Started" && rhs.type === "Started") {
		return matchTypes(lhs.valueType, rhs.valueType, context, NESTED)
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

	if (lhs.type === "Randomness" && rhs.type === "Randomness") {
		return true
	}

	if (lhs.type === "UnionType") {
		let lhsMembers = orderUnionMembersForMatching(lhs.types, context)

		if (rhs.type === "UnionType") {
			// Every actual member must be accepted by some expected member, trying whole
			// members before decomposing a nested one. See "Unions" in DEVELOPMENT.md.
			let matchedWholeMembers = true

			for (let rhsType of rhs.types) {
				let foundMatch = false
				// Each candidate starts from the bindings before it, not a failed one's.
				let attempt = markBindings(context)

				for (let lhsType of lhsMembers) {
					if (matchTypes(lhsType, rhsType, context, depth)) {
						foundMatch = true
						break
					}

					restoreBindings(context, attempt)
				}

				if (!foundMatch && rhsType.type === "UnionType") {
					foundMatch = matchTypes(lhs, rhsType, context, depth)
				}

				if (!foundMatch) {
					matchedWholeMembers = false
					break
				}
			}

			return matchedWholeMembers
		} else {
			// Each member is tried alone, and a failed member's bindings are rolled back,
			// so the order a Union was written in decides nothing.
			let attempt = markBindings(context)

			for (let type of lhsMembers) {
				if (matchTypes(type, rhs, context, depth)) {
					return true
				}

				restoreBindings(context, attempt)
			}
		}

		return false
	}

	// A Case matches only a Case of the same Choice identity and name, then by its
	// payload members. `typeArguments` are display only. See "Cases, Records and
	// Functions" in DEVELOPMENT.md.
	if (lhs.type === "Case" && rhs.type === "Case") {
		if (lhs.choice !== rhs.choice || lhs.name !== rhs.name) {
			return false
		}

		// One Case object matches itself at once, without bookkeeping.
		if (lhs === rhs) {
			return true
		}

		// A pair already being compared is assumed to hold. A counterexample differs at
		// a finite member path, so the assumption is sound.
		let inProgress = activeCasePairs.get(lhs)

		if (inProgress?.has(rhs)) {
			return true
		}

		if (inProgress === undefined) {
			inProgress = new Set()
			activeCasePairs.set(lhs, inProgress)
		}

		inProgress.add(rhs)

		try {
			// Cases sharing a tag share a declaration, so their member names agree, which
			// this checks rather than trusts.
			let lhsMemberNames = Object.keys(lhs.members)

			if (lhsMemberNames.length !== Object.keys(rhs.members).length) {
				return false
			}

			for (let memberName of lhsMemberNames) {
				if (rhs.members[memberName] === undefined) {
					return false
				}

				if (
					!matchTypes(
						lhs.members[memberName],
						rhs.members[memberName],
						context,
						NESTED,
					)
				) {
					return false
				}
			}

			return true
		} finally {
			inProgress.delete(rhs)

			if (inProgress.size === 0) {
				activeCasePairs.delete(lhs)
			}
		}
	}

	if (lhs.type === "Record" && rhs.type === "Record") {
		for (let memberName in lhs.members) {
			// `Object.hasOwn`, since a member may share a name with `Object.prototype`.
			if (!Object.hasOwn(rhs.members, memberName)) {
				return false
			}

			if (
				!matchTypes(
					lhs.members[memberName],
					rhs.members[memberName],
					context,
					NESTED,
				)
			) {
				return false
			}
		}

		return true
	}

	// A Function, a `SimpleMethod` and a `StaticMethod` are one kind of value,
	// matched by signature in both directions. A named Method holds its receiver as
	// the first Parameter.
	if (
		(lhs.type === "Function" ||
			lhs.type === "SimpleMethod" ||
			lhs.type === "StaticMethod") &&
		(rhs.type === "Function" ||
			rhs.type === "SimpleMethod" ||
			rhs.type === "StaticMethod")
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

// An Argument as `matchArguments` reads it. `getType` is asked only after the
// label matched, since enriching can report. `bindings` is the Map still being
// filled, for an Argument matched before its Type Parameters were decided.
export type MatchableArgument = {
	name: string | null
	getType: (
		expectedType: common.Type,
		bindings: GenericBindings | null,
	) => common.Type
	// Set on an Argument that binds no Type Parameter, a prefixed Case construction
	// with no Type Arguments, which its Parameter decides.
	bindsNothing?: boolean
	// The enriched value as a merge into `into` reads it, so a Literal with a
	// path key is measured by its merge. Asked lazily, since it enriches.
	mergedValue?: (
		into: common.Type | common.GenericUse,
	) => common.typed.ExpressionNode | null | undefined
	// Fills the Argument's own `Unknown` slots from the Type the finished call
	// decided. Absent where there is no Node to write onto.
	decide?: (decided: common.Type) => void
	// Set on an Argument written as a Record Literal, the only kind that may be
	// partial. See "Partial Record Arguments" in DEVELOPMENT.md.
	spellsItsMembers?: boolean
}

// Which Argument each Parameter was given, or null for a default, and the
// omitted Parameters, both indexed over the full signature, receiver included.
export type ArgumentPairing = {
	forParameter: Array<number | null>
	omittedParameterIndices: Array<number>
}

// What one refused Argument was refused for, collected only for a report.
// `argumentType` is null where the label disagreed. `matchedParameters` orders
// candidates by how far the call got.
export type ArgumentMismatchDetail = {
	argumentIndex: number
	parameterIndex: number
	matchedParameters: number
	expectedType: common.Type
	argumentType: common.Type | null
}

export type ArgumentMatchResult =
	| { type: "Match"; omittedParameterIndices: Array<number> }
	| { type: "ArityMismatch" }
	| ArgumentMismatch

export type ArgumentMismatch = {
	type: "ArgumentMismatch"
	mismatchedArgumentIndices: Array<number>
	// For Argument `i`, the Parameter it was paired with, for the Validator.
	parameterForArgument: Array<number>
	// Set by `matchFreshened`.
	decided?: GenericBindings
}

// Collects every Type Parameter of this call that `type` mentions. Opaque
// Generics of an enclosing definition are not collected.
function collectBindableGenerics(
	type: common.Type,
	context: GenericInferenceContext,
	into: Set<common.GenericName>,
): void {
	typeWalkFinds(type, (record) => {
		if (
			record.type === "GenericUse" &&
			typeof record.name === "string" &&
			context.bindableNames.has(record.name)
		) {
			into.add(record.name)
		}

		return false
	})
}

// Whether a callback's Parameters mention an unbound Type Parameter. Its return
// Type is one the callback binds, so it is not asked.
function callbackWaitsOnUnboundGeneric(
	callback: common.FunctionType,
	boundSoFar: ReadonlySet<common.GenericName>,
	context: GenericInferenceContext,
): boolean {
	let needed = new Set<common.GenericName>()

	for (let parameter of callback.parameterTypes) {
		collectBindableGenerics(parameter.type, context, needed)
	}

	for (let name of needed) {
		if (!boundSoFar.has(name)) {
			return true
		}
	}

	return false
}

// Whether a callback's Parameters read a Type Parameter that only an Error has
// met so far. See "Type Parameters" in DEVELOPMENT.md.
function callbackWaitsOnError(
	callback: common.Type,
	context: GenericInferenceContext | null,
): boolean {
	if (callback.type !== "Function" || context?.metError === undefined) {
		return false
	}

	let needed = new Set<common.GenericName>()

	for (let parameter of callback.parameterTypes) {
		collectBindableGenerics(parameter.type, context, needed)
	}

	return [...needed].some(
		(name) =>
			context.metError?.has(name) === true && !context.bindings.has(name),
	)
}

// Whether a Parameter Type mentions an unbound Type Parameter of this call.
function parameterWaitsOnUnboundGeneric(
	parameterType: common.Type,
	boundSoFar: ReadonlySet<common.GenericName>,
	context: GenericInferenceContext,
): boolean {
	let needed = new Set<common.GenericName>()

	collectBindableGenerics(parameterType, context, needed)

	for (let name of needed) {
		if (!boundSoFar.has(name)) {
			return true
		}
	}

	return false
}

// The order to match Arguments in, or null for written order. A callback or a
// prefixed Case construction waiting on an unbound Generic goes last. See
// "Argument order" in DEVELOPMENT.md.
function deferredArgumentOrder(
	parameters: common.BaseFunction["parameterTypes"],
	context: GenericInferenceContext | null,
	matchableArguments: Array<MatchableArgument>,
	// Read through the pairing, so an omitted Parameter neither binds nor waits.
	pairing: ArgumentPairing,
): Array<number> | null {
	if (context === null || parameters.length < 2) {
		return null
	}

	let argumentFor = (index: number): MatchableArgument | undefined => {
		let argumentIndex = pairing.forParameter[index]

		return argumentIndex === null || argumentIndex === undefined
			? undefined
			: matchableArguments[argumentIndex]
	}

	// Nothing to reorder where the first waiting Parameter is the last.
	let firstWaiting = parameters.findIndex(
		(parameter, index) =>
			parameter.type.type === "Function" ||
			argumentFor(index)?.bindsNothing === true,
	)

	if (firstWaiting === -1 || firstWaiting === parameters.length - 1) {
		return null
	}

	let boundSoFar = new Set<common.GenericName>()

	for (let name of context.bindableNames) {
		if (context.bindings.has(name)) {
			boundSoFar.add(name)
		}
	}

	let immediate: Array<number> = []
	let deferred: Array<number> = []

	for (let [index, parameter] of parameters.entries()) {
		if (
			parameter.type.type === "Function" &&
			callbackWaitsOnUnboundGeneric(parameter.type, boundSoFar, context)
		) {
			deferred.push(index)

			continue
		}

		if (
			argumentFor(index)?.bindsNothing === true &&
			parameterWaitsOnUnboundGeneric(parameter.type, boundSoFar, context)
		) {
			deferred.push(index)

			continue
		}

		immediate.push(index)

		// What this Parameter can name counts as bound for the ones after it.
		collectBindableGenerics(parameter.type, context, boundSoFar)
	}

	let order = [...immediate, ...deferred]

	if (order.every((value, position) => value === position)) {
		return null
	}

	return order
}

// Whether one Argument answers one Parameter: assignable, or a partial Record
// the default completes. See "Partial Record Arguments" in DEVELOPMENT.md.
function argumentFits(
	parameter: common.Parameter,
	expectedType: common.Type | common.GenericUse,
	argument: MatchableArgument,
	argumentType: common.Type,
	inferenceContext: GenericInferenceContext | null,
): boolean {
	// A Literal with a path key is measured by its merge, and only where the
	// default reaches into a member, since `mergedValue` enriches.
	let effectiveType =
		(parameter.defaultNesting !== undefined &&
		argument.spellsItsMembers === true
			? mergedRecordType(
					expectedType,
					parameter.defaultNesting,
					argument.mergedValue?.(expectedType),
					inferenceContext,
				)
			: null) ?? argumentType

	if (
		matchTypes(parameter.type, effectiveType, inferenceContext, OUTERMOST)
	) {
		return true
	}

	if (
		parameter.defaultMembers === undefined ||
		argument.spellsItsMembers !== true ||
		expectedType.type !== "Record"
	) {
		return false
	}

	// A partial Literal is measured as the merge reads it, each written member
	// typed as it is admitted.
	let partial =
		effectiveType === argumentType
			? (argument.mergedValue?.(expectedType)?.type ?? argumentType)
			: effectiveType

	return (
		partial.type === "Record" &&
		isPartialOf(expectedType, partial, inferenceContext) &&
		missingRecordMembers(expectedType, parameter.defaultMembers, partial)
			.length === 0
	)
}

// The members a Record Argument had to write and did not, by name for the
// Validator.
export function missingRecordMembers(
	parameterType: common.RecordType,
	defaultMembers: ReadonlyArray<string>,
	argumentType: common.RecordType,
): Array<string> {
	let filled = new Set(defaultMembers)

	return Object.keys(parameterType.members).filter(
		(name) =>
			!filled.has(name) && !Object.hasOwn(argumentType.members, name),
	)
}

// Whether Arguments match a parameter list: arity, labels, then Types. See
// "Matching Arguments" in DEVELOPMENT.md.
export function matchArguments(
	parameters: common.BaseFunction["parameterTypes"],
	matchableArguments: Array<MatchableArgument>,
	options: {
		collectAllMismatches?: boolean
		inference?: GenericInferenceContext
		// Where to put what each refusal was about, for the reports naming it.
		explain?: Array<ArgumentMismatchDetail>
	} = {},
): ArgumentMatchResult {
	let pairing = pairArguments(parameters, matchableArguments)

	if (pairing === null) {
		return { type: "ArityMismatch" }
	}

	let inferenceContext = options.inference ?? null
	let mismatchedArgumentIndices: Array<number> = []

	let order = deferredArgumentOrder(
		parameters,
		inferenceContext,
		matchableArguments,
		pairing,
	)

	// A callback waiting on a Type Parameter only an Error has met goes to the
	// back once, since a later Argument may still bind it.
	let queue = parameters.map((_, position) =>
		order === null ? position : order[position],
	)
	let postponed = new Set<number>()

	for (let step = 0; step < queue.length; step++) {
		let i = queue[step]
		let parameter = parameters[i]
		let argumentIndex = pairing.forParameter[i]

		// A Parameter without an Argument takes its default, checked where it was
		// written, and binds nothing.
		if (argumentIndex === null) {
			continue
		}

		if (
			!postponed.has(i) &&
			callbackWaitsOnError(parameter.type, inferenceContext)
		) {
			postponed.add(i)
			queue.push(i)

			continue
		}

		let position = step - postponed.size
		let argument = matchableArguments[argumentIndex]

		// Substituting the bindings so far gives a deferred callback its real Types.
		// A callback is typed as if an Error met only had bound what it met.
		let expectedType =
			inferenceContext === null
				? parameter.type
				: applyGenericBindings(
						parameter.type,
						parameter.type.type === "Function"
							? bindingsWithErrorFallback(inferenceContext)
							: inferenceContext.bindings,
					)

		// The label is compared first, so an Argument at the wrong label is never
		// typed.
		if (parameter.name === argument.name) {
			let argumentType = argument.getType(
				expectedType,
				inferenceContext?.bindings ?? null,
			)

			if (
				argumentFits(
					parameter,
					expectedType,
					argument,
					argumentType,
					inferenceContext,
				)
			) {
				continue
			}

			options.explain?.push({
				argumentIndex,
				parameterIndex: i,
				matchedParameters: position,
				expectedType,
				argumentType,
			})
		} else {
			options.explain?.push({
				argumentIndex,
				parameterIndex: i,
				matchedParameters: position,
				expectedType,
				argumentType: null,
			})
		}

		if (!options.collectAllMismatches) {
			return {
				type: "ArgumentMismatch",
				mismatchedArgumentIndices: [argumentIndex],
				parameterForArgument: argumentPairingInverse(pairing),
			}
		}

		mismatchedArgumentIndices.push(argumentIndex)
	}

	if (mismatchedArgumentIndices.length > 0) {
		// Sorted back into written order for the Validator.
		return {
			type: "ArgumentMismatch",
			mismatchedArgumentIndices: mismatchedArgumentIndices.sort(
				(left, right) => left - right,
			),
			parameterForArgument: argumentPairingInverse(pairing),
		}
	}

	if (inferenceContext !== null) {
		settleErrorBindings(inferenceContext)
	}

	return {
		type: "Match",
		omittedParameterIndices: pairing.omittedParameterIndices,
	}
}

// The Parameters and Arguments of a refused call, as a reader pairs them. Each
// Argument meets the Parameter of its label, or the unlabelled one at its place
// among the unlabelled. One meeting none is left out.
export function pairedByPlace(
	parameters: common.BaseFunction["parameterTypes"],
	matchableArguments: Array<MatchableArgument>,
): [common.BaseFunction["parameterTypes"], Array<MatchableArgument>] {
	let unlabelled = parameters.filter((parameter) => parameter.name === null)
	let unlabelledSeen = 0
	let paired: common.BaseFunction["parameterTypes"] = []
	let kept: Array<MatchableArgument> = []

	for (let argument of matchableArguments) {
		let parameter =
			argument.name === null
				? unlabelled[unlabelledSeen++]
				: parameters.find(
						(candidate) => candidate.name === argument.name,
					)

		if (parameter !== undefined && !paired.includes(parameter)) {
			paired.push(parameter)
			kept.push(argument)
		}
	}

	return [paired, kept]
}

// Which Argument answers which Parameter, from labels and `hasDefault` alone,
// so it is cheap and works before typing. The walk is greedy, which
// `indistinguishable-default-parameter` makes complete. Null is an arity mismatch.
export function pairArguments(
	parameters: common.BaseFunction["parameterTypes"],
	matchableArguments: Array<MatchableArgument>,
): ArgumentPairing | null {
	if (!parameters.some((parameter) => parameter.hasDefault)) {
		return parameters.length === matchableArguments.length
			? identityPairing(parameters.length)
			: null
	}

	let forParameter: Array<number | null> = []
	let omittedParameterIndices: Array<number> = []
	let next = 0

	for (let parameter of parameters) {
		let argument = matchableArguments[next]

		if (argument !== undefined && argument.name === parameter.name) {
			forParameter.push(next)
			next++
		} else if (parameter.hasDefault) {
			forParameter.push(null)
			omittedParameterIndices.push(forParameter.length - 1)
		} else if (argument !== undefined) {
			// A required Parameter and a disagreeing label are paired anyway, so the
			// mismatch is reported as a label, not a count.
			forParameter.push(next)
			next++
		} else {
			return null
		}
	}

	// Left-over Arguments mean the walk skipped a default a mislabelled Argument
	// was meant for. Where the counts agree, the identity pairing reports the label.
	if (next !== matchableArguments.length) {
		return parameters.length === matchableArguments.length
			? identityPairing(parameters.length)
			: null
	}

	return { forParameter, omittedParameterIndices }
}

// Argument `i` answers Parameter `i`. Cached per arity, since nothing writes
// into a pairing.
const identityPairings: Array<ArgumentPairing> = []

function identityPairing(length: number): ArgumentPairing {
	let cached = identityPairings[length]

	if (cached === undefined) {
		cached = {
			forParameter: Array.from({ length }, (_, index) => index),
			omittedParameterIndices: [],
		}
		identityPairings[length] = cached
	}

	return cached
}

// For Argument `i`, the Parameter it answers, built only where something must
// name that Parameter.
export function argumentPairingInverse(
	pairing: ArgumentPairing,
): Array<number> {
	let parameterForArgument: Array<number> = []

	for (let [index, argumentIndex] of pairing.forParameter.entries()) {
		if (argumentIndex !== null) {
			parameterForArgument[argumentIndex] = index
		}
	}

	return parameterForArgument
}
