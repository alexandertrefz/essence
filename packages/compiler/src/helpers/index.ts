import type { common, lexer } from "@essence-lang/interfaces"

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

// NOTE: The spelling a Generic is SHOWN under. `createFreshenedInference`
// alpha-renames a callee's Generics for the span of one invocation — `T`
// becomes `T`, a zero-width space and a counter — and a Generic that never
// binds stays under that fresh name in the Types stamped onto the Argument
// Nodes, which is where Hover and Inlay Hints read their Types back from: the
// reader is shown `T117`, since only the separator is invisible. Stripped
// where a name is rendered rather than un-freshened in the Types themselves,
// so the fresh name stays the collision-proof symbol inference needs it to
// be. A source Generic can not carry a zero-width space — the assumption the
// freshening itself rests on — so nothing a Program spells is touched.
export function displayGenericName(name: common.GenericName): string {
	return name.replace(/\u200B\d+$/, "")
}

// NOTE: The nominal identity of a Choice — what tells two Modules' same-named
// Choices apart, and the whole of what `matchTypes` compares a Case by. It is
// the Module's canonical path and the name the declaration wrote, because the
// path alone would join every Choice in one file and the name alone joins the
// two files. The path rather than anything entry-relative: a file reached from
// two entries must not split into two Types, and the Language Server's index
// has no entry at all.
// `modulePath` is null for a Program that is no Module — a single file compile
// and every standard library file identify a Choice by its bare name, which is
// the spelling every emitted tag, `__golden__` file and Diagnostic has carried
// since before Modules.
export function choiceIdentity(
	modulePath: string | null,
	name: string,
): string {
	return modulePath === null ? name : `${modulePath}#${name}`
}

// NOTE: The Choice name a reader wrote, recovered from the identity above:
// everything after the LAST separator, since a Module path may well contain one
// and a Choice's name can not. Every site that PRINTS a Choice goes through
// here — a Diagnostic, Hover or Completion naming the path would be naming
// something the source does not say.
export function displayChoiceName(identity: string): string {
	return identity.slice(identity.lastIndexOf("#") + 1)
}

// NOTE: The Type Arguments an applied refinement is spelled with in a HOVER, or
// null when the bare Alias name says everything. A non-generic refinement carries
// none at all, and an instantiation that bound every Parameter to a Parameter —
// the one a generic Namespace makes of its own target — would only echo the
// header, so it stays terse. The same rule `caseHeader` reads a Case's Arguments
// by, for the same reason and with the same wording.
//
// A DIAGNOSTIC can not be terse this way: it names a Type the reader is asked to
// do something about, and `describeType` spells the Arguments out for that reason
// — see its own NOTE.
export function displayedRefinementArguments(
	type: common.RefinementType,
): Array<common.Type> | null {
	if (
		type.typeArguments === undefined ||
		type.typeArguments.every(
			(typeArgument) => typeArgument.type === "GenericUse",
		)
	) {
		return null
	}

	return type.typeArguments
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
			return `${displayChoiceName(type.choice)}#${type.name}`
		// NOTE: A checked refinement is named, never spelled out — the reader
		// wrote `NonZeroInteger`, and `Integer where @::isNot(0)` is the
		// Declaration rather than the Type a Diagnostic is about. An applied
		// generic one is named as it was applied: a message about `NonEmptyList` where
		// the reader wrote `NonEmptyList<String>` names half a Type.
		//
		// Which holds just as much where the Arguments are Type PARAMETERS. The
		// Hover's terser rule drops those, and a Diagnostic must not: it names a
		// Type the reader is asked to write, check or pass a value of, and
		// 'NonEmptyList' is not one — a Program spelling it bare is refused for
		// taking no Arguments. So an applied refinement is spelled as applied,
		// whatever it was applied TO, and only a refinement that takes no Arguments
		// at all spells as its name alone.
		case "Refinement":
			return type.typeArguments === undefined
				? type.name
				: `${type.name}<${type.typeArguments
						.map(describeType)
						.join(", ")}>`
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
			return describeFunctionSignature(type)
		// NOTE: An Overload set has no ONE signature to print, and spelling
		// every Overload out would drown the message it sits in — it stays the
		// bare word. A Diagnostic that has an Overload set in hand names the
		// Overloads itself, as per-candidate notes.
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return "Function"
		case "Namespace":
			return `Namespace '${type.name}'`
		case "GenericUse":
		case "GenericAlias":
			return displayGenericName(type.name)
		default:
			return type.type
	}
}

// NOTE: A function-ish Type spelled the way a Type Annotation spells it —
// `(_: Integer) -> Integer`, a labelled Parameter under its label. The bare
// word "Function" named every one of them alike, which made a mismatch read as
// "this is a Function, and it is declared as Function"; the signature is the
// part that differs, so it is the part a Diagnostic has to show. The internal
// name a Declaration may write (`_ x: Integer`) documents the Parameter and is
// not part of the Type, so it can not be printed back.
// A Method NAMED rather than called carries its receiver as the first
// Parameter (see `matchTypes`), and it is printed there — that receiver is
// exactly what makes it not fit a Function of one Argument fewer.
function describeFunctionSignature(functionType: common.BaseFunction): string {
	let parameters = functionType.parameterTypes
		.map(
			(parameter) =>
				`${parameter.name ?? "_"}: ${describeType(parameter.type)}`,
		)
		.join(", ")

	return `(${parameters}) -> ${describeType(functionType.returnType)}`
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

// NOTE: The hidden trailing Parameter a Protocol-bounded Type Parameter adds to
// an emitted Function, and the name a call site inside that Function forwards
// as its own witness. Four stages spell it — the Enricher when it solves a
// witness, the Simplifier when it emits the Parameter, the Validator when it
// checks that the one resolves to the other, and the native-table generator —
// and a Program only runs while all four agree, so they say it once.
//
// NOTE: `_` is a Symbol to the Lexer, so no user identifier can contain one and
// this name can not collide with anything written in a Program.
export function conformanceParameterName(genericName: string): string {
	return `${genericName}__conformance`
}

// NOTE: The unit Type — the empty Record, `{}`. A Function that answers
// nothing useful says so by promising a Record with no members: there is
// nothing to read off it, and a caller that tries names a member it does not
// have. Essence had a `Nothing` Type for this and it earned its keep nowhere
// else — a functional language has no statements to sequence, so "returns
// nothing useful" is the whole of what it ever meant, and `{}` says that
// without a Type of its own.
//
// Two stages ask: the Validator lets a body promising it fall off its end, and
// the Simplifier spells the fall-off out. They must agree, so they ask here.
export function isUnitType(type: common.Type): boolean {
	return type.type === "Record" && Object.keys(type.members).length === 0
}

// NOTE: Whether every path through a body reaches a `<-`. Two stages need the
// same answer and must never disagree: the Validator refuses a body that
// promises a value and can fall off its end, and the Simplifier gives the
// bodies that may fall off — the ones returning unit — the `return` that says
// so, because JavaScript would otherwise answer `undefined`, which is not an
// Essence value at all. Conservative on purpose: only a `<-` and an
// `if`/`else` whose both halves return count, so anything it can not see
// through is treated as falling through.
export function bodyDefinitelyReturns(
	body: Array<common.typed.ImplementationNode>,
): boolean {
	return body.some(nodeDefinitelyReturns)
}

function nodeDefinitelyReturns(node: common.typed.ImplementationNode): boolean {
	if (node.nodeType === "ReturnStatement") {
		return true
	}

	if (node.nodeType === "IfElseStatement") {
		return (
			bodyDefinitelyReturns(node.trueBody) &&
			bodyDefinitelyReturns(node.falseBody)
		)
	}

	return false
}

// NOTE: A structural walk over a Type, visiting each object it is built from
// exactly once. Types are plain data, so walking them covers every shape —
// including ones added later — without enumerating any, which is why the four
// questions below are all asked this way.
//
// A resolved Type is a DAG, though, not a tree: `type Nested = Box<Inner> |
// Box<List<Inner>>` names the ONE `Inner` object from four places, its Type
// Arguments and its Cases' members among them, and each level of nesting
// multiplies that sharing again. Followed reference by reference, a Type a few
// hundred objects large is walked exponentially many times — asking whether an
// eight-level nesting mentions an unsolved Type Parameter took thirty-seven
// million steps, and twelve levels never finished. Remembering what has been
// visited makes the walk linear in the Type as it is actually held, and answers
// where a Type that named itself would have hung.
//
// Every question asked this way is monotone — "is there an X anywhere" or
// "collect every X" — so a second visit to a shared object could only find what
// the first one already did.
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

		return Object.values(record).some(walk)
	}

	return walk(type)
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

// NOTE: A per-instantiation counter for `createFreshenedInference`. Only its
// uniqueness matters, never its value — it never reaches a Type a Program can
// observe, so it does not compromise the determinism the Enricher otherwise
// keeps (unlike `Date.now`/`Math.random`, which are banned for that reason).
let freshGenericCounter = 0

// NOTE: What separates a freshened Generic's name from its counter. A source
// Generic can not carry it, which is the whole assumption the alpha-renaming
// below rests on.
const freshGenericSeparator = "\u200B"

// NOTE: Whether a Type still carries a Type Parameter of the call it is being
// matched against — one `createFreshenedInference` renamed for the span of this
// match and that the match has not solved. Every Parameter it DID solve was
// substituted away by `applyGenericBindings` before the Type got here, so a
// fresh name still standing in it is exactly a slot this call has not decided.
// Asked where a decision has to be committed rather than merely checked: an
// enclosing Function's own Type Parameter is a decision (a generic one), and it
// reads as a source name, while a callee's unsolved one is no decision at all
// and must never be recorded as one.
export function mentionsUnsolvedTypeParameter(type: common.Type): boolean {
	return typeWalkFinds(
		type,
		(record) =>
			record.type === "GenericUse" &&
			typeof record.name === "string" &&
			record.name.includes(freshGenericSeparator),
	)
}

// NOTE: Alpha-renames a signature's own Generics to fresh, collision-proof names
// for the span of one invocation's Argument matching. A caller may declare a
// Generic under the SAME spelling as the callee's — a Method generic in
// `ItemType` calling `List.reduce`, whose Namespace Generic is also `ItemType`;
// a `loop` entry generic in `State` calling another `loop` entry, also `State`
// — and Generic identity is by name across the compiler, so without this the
// callee's bindable `ItemType` and the caller's opaque `ItemType` are the same
// symbol: the bindable one binds to a Type mentioning the opaque one, then
// substitutes the name into itself until the stack dies. A fresh name carries a
// zero-width space, which no source Generic can, plus the counter, so it
// collides with nothing. ONLY the Parameter Types matched here are renamed; the
// bindings that come back are translated to the original names by
// `unfreshenBindings`, so the return Type, conformances and every Diagnostic
// still read in the Generics the source wrote.
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

// NOTE: The construction-side twin of `createFreshenedInference` — a Choice's
// own Type Parameters, alpha-renamed for the span of the one payload match that
// binds them. The collision it settles is the same one, one rail over: a
// callback inside `myCount<State>` answering `#Done(current.carried)` hands a
// payload Typed as the CALLER's opaque `State` to `Step<State, Result>`, and by
// name alone that payload matched `Step`'s own bindable `State` — so `State`
// bound to the whole Record and `Result`, the Parameter the payload was there to
// decide, bound to nothing at all.
//
// A Parameter the payload never binds is left standing under its FRESH name
// rather than restored, deliberately: it is a Type Argument nothing decided, and
// `mentionsUnsolvedTypeParameter` is what the construction rail asks to tell one
// from an enclosing Function's own Type Parameter, which is a decision (a
// generic one) and reads as a source name. `displayGenericName` shows it under
// the spelling the Choice declares, so a reader never sees the counter.
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
			// NOTE: Every one of them, unlike a signature's, where only an
			// `infer` Parameter binds — a Choice's Type Parameters are applied
			// rather than declared bindable, and the payload match is the one
			// place they are worked out from a value at all.
			bindableNames: new Set(freshNames),
			bindings: new Map(),
		},
	}
}

// NOTE: The name a FABRICATED signature borrows a Type Parameter under. A
// derived Method takes its Parameters from the Type it was fabricated for, so
// their names are that Type's own — and `createFreshenedInference` can not undo
// a collision with the CALLER's Generics on its own here, because the receiver's
// Type Arguments arrive as `defaultType` pins, which are caller-side Types: the
// alpha-rename above renamed the pin along with the Parameter it pinned, and the
// Parameter ended up pinned to itself. Borrowing under a name no source Generic
// can carry settles it before an invocation ever sees the signature. Stable
// rather than counted, because the invocation freshens on top of this anyway and
// a fabricated signature should be the same every time it is built.
export function borrowedGenericName(
	name: common.GenericName,
): common.GenericName {
	return `${name}${freshGenericSeparator}`
}

// NOTE: Translates the bindings collected against freshened Generic names back
// to the Generics the signature declares, so the return-Type substitution and
// conformance resolution downstream read in the original names. Binding VALUES
// come from the Arguments, which never mention the callee's fresh names — but a
// `defaultType` that referenced a sibling Generic could, so they are
// un-freshened too.
export function unfreshenBindings(
	bindings: GenericBindings,
	freshToOriginal: Map<common.GenericName, common.GenericName>,
): GenericBindings {
	if (freshToOriginal.size === 0) {
		return bindings
	}

	let reverse: GenericBindings = new Map()

	for (let [fresh, original] of freshToOriginal) {
		reverse.set(fresh, { type: "GenericUse", name: original })
	}

	let result: GenericBindings = new Map()

	for (let [name, type] of bindings) {
		result.set(
			freshToOriginal.get(name) ?? name,
			applyGenericBindings(type, reverse),
		)
	}

	return result
}

// NOTE: A Namespace as the specificity order below sees it — the target Type
// exactly as DECLARED, plus the Generics that are open in it. Never a
// specialized copy: `List<Integer>` specialized out of `List<ItemType>` is
// structurally identical to a hand written `for List<Integer>`, and comparing
// those two would tie where one is strictly narrower.
export type NamespaceTarget = {
	targetType: common.Type | null
	generics: Array<common.GenericDeclaration>
}

// NOTE: Whether `pattern`'s target Type covers `subject` with the pattern's own
// Generics OPEN — `List<ItemType>` covers `List<Integer>` and `List<List<X>>`,
// while `List<List<ItemType>>` covers only the nested one. The pattern's
// Generics are alpha-renamed first, exactly as `createFreshenedInference` does
// for a call's Parameters: Namespaces spell their Generics alike (`ItemType`
// throughout the stdlib) and Generic identity is by name, so without the rename
// the pattern's bindable `ItemType` and the subject's opaque one are a single
// symbol — `List<List<ItemType>>` binds `ItemType` to a Type mentioning itself,
// reads as covering `List<ItemType>`, and the two targets tie.
function targetCoversAsPattern(
	pattern: NamespaceTarget,
	subject: common.Type,
): boolean {
	if (pattern.targetType === null) {
		return false
	}

	if (pattern.generics.length === 0) {
		return matchesType(pattern.targetType, subject)
	}

	let rename: GenericBindings = new Map()

	for (let generic of pattern.generics) {
		rename.set(generic.name, {
			type: "GenericUse",
			name: `${generic.name}${freshGenericSeparator}${(freshGenericCounter += 1)}`,
		})
	}

	let generics = pattern.generics.map((generic) => ({
		...generic,
		name: (rename.get(generic.name) as common.GenericUse).name,
		defaultType:
			generic.defaultType === null
				? null
				: applyGenericBindings(generic.defaultType, rename),
	}))

	return matchesTypeWithBindings(
		applyGenericBindings(pattern.targetType, rename),
		subject,
		createInferenceContext(generics),
	)
}

// NOTE: THE specificity order over overlapping Namespaces, shared by Method
// dispatch and Protocol conformance so both answer "which Namespace covers this
// receiver more closely" the same way. `target` wins when `other` covers it as a
// pattern and not the other way around: a concrete `List<Integer>` beats the
// generic `List<ItemType>`, and the deeper `List<List<ItemType>>` beats the
// shallower `List<ItemType>`. Everything else is a tie the callers report: the
// same target twice, and equally a pair the cover fails both ways for — a
// `List<Integer> | Nothing` is no case of a `List<ItemType>` and no `List<…>`
// is a case of that Union, so a receiver matching both has no narrower
// Namespace to be dispatched to.
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

// NOTE: Keeps only the candidates no other candidate is strictly more specific
// than. A cyclic order would leave nothing standing, which must not read as "no
// Namespace matched" — the unfiltered set is handed back instead, and the
// caller reports the ambiguity it already reports for a tie.
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

// NOTE: The copies taken of a refinement whose predicate is still unread, kept
// from the source object to the copies made of it. It exists ONLY while a hoist
// is open — outside one there is no fill left to complete a pending copy, so
// taking one is a Compiler bug and stays a throw.
//
// Keyed by the object copied FROM rather than by the Alias, because a pending
// copy is itself pending and may be copied again — `NonEmptyList<Item>` in a
// signature, instantiated once more at a call site — and the fill has to reach
// those too. Walking the map from the Alias' own object finds every generation.
//
// Entries are never removed one at a time. A copy taken during a round that then
// failed to hoist is speculative garbage the fill writes into for nothing, which
// costs a field write and is far cheaper than working out which copies a
// discarded speculation left behind.
let pendingRefinementCopies = new Map<
	common.RefinementType,
	Array<common.RefinementType>
>()

// NOTE: Hoists NEST — a name resolved during a Program's rounds may be the
// first to touch the standard library, whose lazy load hoists every library
// file inside that round. So the registry is opened by counting rather than by
// replacing: the inner hoist registers into the same map, the outer's fill still
// finds its own entries, and only the outermost close clears it.
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

// NOTE: THE door every copy of a refinement goes through, and the reason there
// are only two callers rather than a spread at each site: a copy taken while the
// predicate is still unread is a promise to finish it, and the promise is kept by
// registering the copy against the object it came from. The fill then hands the
// Alias and every copy of it the very same conjuncts array, so nothing
// downstream can tell one from the other.
//
// A copy of a RESOLVED refinement needs none of this — its conjuncts already
// travel by reference — so it passes straight through.
function trackedRefinementCopy(
	source: common.RefinementType,
	copy: common.RefinementType,
): common.RefinementType {
	if (source.conjuncts !== null) {
		return copy
	}

	// NOTE: Outside an open hoist the throw stays and means what it always
	// meant. There is no fill left to complete the copy, so a pending refinement
	// reaching here at all is a Compiler bug — the same one every other reader of
	// `conjuncts` refuses by throwing.
	if (openHoists === 0) {
		throw new Error(
			`Internal Compiler Error: the predicate of refinement '${source.name}' was read before it resolved`,
		)
	}

	let copies = pendingRefinementCopies.get(source)

	if (copies === undefined) {
		pendingRefinementCopies.set(source, [copy])
	} else {
		copies.push(copy)
	}

	return copy
}

// NOTE: The applied spelling stamped onto an instantiation, which is the second
// place a refinement is copied — `NonEmptyList<String>` prints as written rather
// than as the bare Alias name every instantiation would otherwise share. It goes
// through the same door as the substitution above, because a copy taken here of a
// still-pending predicate has to be registered exactly as one taken there does:
// the stamp is what the signature ends up holding, and an unregistered stamp
// would keep the null after the fill wrote the conjuncts into everything else.
export function refinementWithTypeArguments(
	refinement: common.RefinementType,
	typeArguments: Array<common.Type>,
): common.RefinementType {
	return trackedRefinementCopy(refinement, { ...refinement, typeArguments })
}

// NOTE: Every copy taken of this refinement, copies of those copies included —
// what the fill hands the conjuncts to, and what the poison path turns into its
// own base. The walk terminates without a visited set because every registration
// is a FRESH object: a copy is never its own source, and no object is ever
// registered twice, so the entries form a tree rooted at the Alias' object.
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
		// NOTE: A refinement's conjuncts are keys rather than Types, so only the
		// base can hold a Generic — `NonEmptyList<Item>`'s `List<Item>` is where one
		// does. The conjuncts travel along BY REFERENCE and unsubstituted, which is
		// the whole reason a generic refinement costs so little: a predicate that
		// could mention the item Type would not typecheck against an opaque one, so
		// what survives is item-agnostic and the Type Arguments live in the base,
		// where `matchTypes` already compares them.
		//
		// NOTE: An applied spelling substitutes right along with the base, so
		// `NonEmptyList<Item>` heals into `NonEmptyList<String>` rather than going stale —
		// the same healing an applied Union's `alias` gets below, and just as
		// display-only.
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

			// NOTE: Copying a PENDING predicate is what lets the Namespace that
			// ANSWERS a generic Alias' predicate apply that Alias in its own
			// signatures — `namespace List` answering `hasItems` while promising
			// `append(_ item) -> NonEmptyList<ItemType>`. Refusing the copy would send
			// the Namespace back into the rounds, and the fill would then look for
			// `hasItems` on a Namespace that never hoisted: a deadlock no ordering can
			// undo, because each side is the other's precondition. So the copy is
			// taken and REGISTERED, and the fill finishes it along with the Alias.
			//
			// Which is why the identity check sits AHEAD of this. A refinement whose
			// base holds no Type Parameter — every non-generic one, `NonZeroInteger`
			// among them — comes back AS ITSELF whatever bindings it is handed, so a
			// generic Namespace with a refined signature (`divide(by NonZeroInteger)`)
			// is never copied and never registered, exactly as it was before generic
			// refinements existed.
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

			// NOTE: A DECLARED Case of a generic Choice (`choiceGenerics` set,
			// no `typeArguments` yet) is being instantiated — force a fresh
			// object so the applied spelling can be stamped, mirroring the Union
			// alias healing above. Everything else (a plain Case, an already
			// instantiated one whose members and Arguments are untouched) comes
			// back identical, the identity that keeps matchTypes' `lhs === rhs`
			// fast path O(1) for every non-generic Choice.
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
				// NOTE: The applied spelling, in declaration order — an unbound
				// Generic stays a GenericUse so a later substitution can still
				// bind it (a never-`#Done` callback keeps `Result` open). The
				// declared-only `choiceGenerics` is dropped; what survives is an
				// instantiated Case carrying its `typeArguments`.
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
			// NOTE: A Generic already bound to exactly this opaque Generic is
			// consistent by identity — short-circuit. Without this, verifying
			// the binding recurses forever when the bound value is a Generic use
			// of the same name: a Method forwarding a same-named Generic to
			// another binds `ItemType := ItemType` off the receiver, then
			// re-matches that binding against the argument's identical
			// `ItemType`, which matches the binding, which re-matches… A concrete
			// binding never hits this and still checks through `checkAgainstBinding`.
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

	// NOTE: A Generic that is not bindable here is an opaque symbol of an
	// enclosing definition — it only matches itself, which the caller has
	// already checked.
	return false
}

// NOTE: A mark in a context's bindings, taken before a match attempt — the
// number of bindings it starts from. Everything the attempt binds is added
// AFTER the mark, so `restoreBindings` can undo a failed attempt by dropping
// the tail, which beats copying the whole Map for every attempt of every Union
// member the Enricher meets. What makes the tail exactly the attempt's own work
// is that bindings only ever GROW while a Type is matched: `matchGenericUse`
// binds a Generic on its FIRST occurrence and only ever CHECKS it afterwards,
// so no earlier binding can be overwritten out from under the mark, and a Map
// iterates in insertion order.
function markBindings(context: GenericInferenceContext | null): number {
	return context === null ? 0 : context.bindings.size
}

// NOTE: Rolls a context back to a mark — the state before a match attempt that
// has since failed. A failed attempt may well have bound Generics on its way
// down, and those bindings are worth no more than the attempt that made them:
// left behind, they decide the attempts that follow. The bindings are dropped
// in place rather than the Map replaced, so every holder of the context keeps
// looking at the same object.
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
	return typeMentionsAnyGeneric(type, new Set([genericName]))
}

// NOTE: The same walk where the NAMES are what is wanted rather than a yes or
// no. Asked of a refinement's base, whose Type Parameters are exactly the ones a
// value standing at that position may decide: `NonEmptyList<Item>` is a Type only
// once something says what `Item` is, and unifying the base against the value's
// own Type is how that is worked out.
export function genericNamesMentioned(
	type: common.Type,
): Set<common.GenericName> {
	let names = new Set<common.GenericName>()

	// NOTE: A search that never finds anything, so the whole Type is walked —
	// collecting is what it is here for, and answering would stop it early.
	typeWalkFinds(type, (record) => {
		if (record.type === "GenericUse" && typeof record.name === "string") {
			names.add(record.name)
		}

		return false
	})

	return names
}

// NOTE: The same walk over a whole SET of Generic names, which is what
// Argument ordering asks (`does this Parameter wait on anything still
// unbound?`) — one pass instead of one per name.
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

// NOTE: Whether an Error Type sits anywhere in this one — the same structural
// walk, for the same reason it does not enumerate shapes. An Error was already
// reported where it came from, so a Type carrying one buried in a List's items
// or a Record's members must not be diagnosed a second time for whatever it
// then fails to do.
export function typeContainsError(type: common.Type): boolean {
	return typeWalkFinds(type, (record) => record.type === "Error")
}

// NOTE: Whether a checked refinement sits anywhere in this Type — the same
// structural walk again, and for one purpose: refinements erase before
// emission, so a Type still carrying one where the Rewriter is about to
// SERIALIZE it names a Compiler bug rather than a Program's mistake. The walk
// reads every field so that a refinement buried in a List's items or a Record's
// member is found too, which is exactly where a hand written eraser would miss
// one.
export function typeContainsRefinement(type: common.Type): boolean {
	return typeWalkFinds(type, (record) => record.type === "Refinement")
}

// NOTE: What makes two predicate leaves the SAME question — the Namespace that
// answers it, the Method, which Overload of it, and the Arguments. Assignability
// between two refinements is set inclusion over these keys, so nothing may spell
// two questions alike. Which is why the separator is a COLON and the Arguments
// are JSON: the Lexer reads `:` as a Symbol, so no name a Program can write
// holds one, while `$` is an ordinary Identifier character — a Method called
// `isNot$1` would otherwise key exactly as Overload 1 of `isNot` — and a String
// Argument may hold whatever a joined list's separator would have been.
export function predicateConjunctKey(
	conjunct: common.PredicateConjunct,
): string {
	return `${conjunct.namespaceName}::${conjunct.methodName}:${
		conjunct.overloadIndex ?? ""
	}${JSON.stringify(conjunct.args)}`
}

// NOTE: The one door to a refinement's conjuncts. They are null while the
// predicate is still unresolved — the state a refined Alias hoists in when the
// Namespace answering its predicate has not hoisted yet — and NOTHING may be
// decided about a predicate nobody has read: not assignability, not literal
// admission, not a narrowing, and above all nothing a memo would keep. So the
// null is refused by throwing, which the hoisting rounds already read as "not
// this round" — the asker is retried once the predicate has been written in.
// Hoisting guarantees the null does not survive it, so a throw reaching anyone
// ELSE is a Compiler bug by definition, and the message says so.
export function provenConjuncts(
	refinement: common.RefinementType,
): Array<common.PredicateConjunct> {
	if (refinement.conjuncts === null) {
		throw new Error(
			`Internal Compiler Error: the predicate of refinement '${refinement.name}' was read before it resolved`,
		)
	}

	return refinement.conjuncts
}

// NOTE: The canonical form a refinement's conjuncts are stored in — sorted by
// key, with duplicates dropped, so that one predicate spells one conjunct set
// however it was written. Two aliases proving the same thing are then the same
// Type to every reader of `conjuncts`, and the inclusion check above never has
// to care that `@::isNot(0)::and(@::isPositive())` and its mirror image are the
// same predicate.
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

// NOTE: Whether a slot nothing has decided yet sits anywhere in this Type. It
// enumerates the shapes on purpose, unlike its Error-hunting sibling: an
// Unknown also occurs as the DECLARED default of `List`'s Type Parameter, and a
// walk that reads every field would call every bare `List` undecided. Only the
// places a Type ARGUMENT can end up in are looked at — a List's items, a
// Record's members, a Union's arms — which is also what keeps a Choice's
// self-referential payload from looping.
export function typeContainsUnknown(type: common.Type): boolean {
	switch (type.type) {
		case "Unknown":
			return true
		case "List":
			return typeContainsUnknown(type.itemType)
		case "Record":
			return Object.values(type.members).some(typeContainsUnknown)
		case "UnionType":
			return type.types.some(typeContainsUnknown)
		// NOTE: A refinement decides nothing its base has not decided — what is
		// still undecided about `List<Unknown> where …` is the item Type.
		case "Refinement":
			return typeContainsUnknown(type.base)
		default:
			return false
	}
}

// NOTE: `stored` with every Unknown slot `value` has an answer for filled in —
// what turns `variable items = []` into a List of Integers the moment
// `items = [1, 2]` says so. Only slots that are Unknown are touched, so a Type
// that already decided something keeps it and the caller can tell that nothing
// was pinned by getting the very same Type back.
//
// An Error is not an answer: whatever produced it was reported where it came
// from, and pinning a slot to it would spread that one mistake over every later
// use of the name.
export function resolveUnknownSlots(
	stored: common.Type,
	value: common.Type,
): common.Type {
	// NOTE: A Choice's payload may name the Choice, so a Union arm can lead
	// back to a Type already being walked.
	let visiting = new Set<common.Type>()

	let resolve = (stored: common.Type, value: common.Type): common.Type => {
		if (stored === value || visiting.has(stored)) {
			return stored
		}

		if (stored.type === "Unknown") {
			return value.type === "Unknown" || typeContainsError(value)
				? stored
				: value
		}

		visiting.add(stored)

		try {
			if (stored.type === "List" && value.type === "List") {
				let itemType = resolve(stored.itemType, value.itemType)

				return itemType === stored.itemType
					? stored
					: { type: "List", itemType }
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
				// NOTE: Arms are paired by shape — a `List` arm is answered by
				// the value's `List` arm — and only when exactly one arm
				// answers. Two arms of the same shape have no obvious pairing,
				// and guessing one would decide a slot from the wrong Type.
				let types = stored.types.map((arm) => {
					let candidates = value.types.filter(
						(candidate) => candidate.type === arm.type,
					)

					return candidates.length === 1
						? resolve(arm, candidates[0])
						: arm
				})

				// NOTE: The name and the alias are dropped along with the arm
				// they described — `Optional<List<Unknown>>` is not what a
				// Union whose List arm now holds Integers is called.
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

// NOTE: The subsumption order Union building dedupes by — whether `member`
// says nothing `existing` does not already cover. Assignability alone can not
// answer that: the Unknown item Type an empty List Literal carries is a
// wildcard in BOTH directions — `List<Unknown>` accepts `List<Integer>`
// through the Unknown rule and is accepted by it through the empty-List rule —
// so the two subsume each other and whichever was collected FIRST would
// survive. That is right for assignability, an empty List really does fit any
// List, but as a specificity order it destroys exactly the information the
// checker needs: `[[], [1]]` would build `List<List<Unknown>>`, a Type that
// fits every List Type, and `constant broken: List<List<String>> = [[], [1]]`
// would pass while its reversed spelling is rejected. So when two members
// accept one another, the one that spells more out wins and the empty List's
// placeholder yields to the concrete Type beside it — the empty Literal itself
// stays assignable everywhere, since nothing about `matchesType` changes.
function subsumesForUnion(existing: common.Type, member: common.Type): boolean {
	if (!matchesType(existing, member)) {
		return false
	}

	return !(isLessSpecific(existing, member) && matchesType(member, existing))
}

// NOTE: Whether `left` says strictly less about the same shape than `right` —
// an Unknown standing where `right` names a Type. ONLY the placeholder an
// empty List Literal leaves behind is weighed; every other pair reports no
// difference, so nothing but that one wildcard can change which member of a
// Union survives.
function isLessSpecific(left: common.Type, right: common.Type): boolean {
	if (left.type === "Unknown") {
		return right.type !== "Unknown"
	}

	if (left.type === "List" && right.type === "List") {
		return isLessSpecific(left.itemType, right.itemType)
	}

	return false
}

// NOTE: Builds a Union from a list of members. Members that subsume one another
// collapse (`Integer` alongside `Number` becomes just `Number`), anonymous
// nested Unions are flattened in, and NAMED ones (`Number`, a Choice, an
// applied `Optional<X>`, a named Alias) stay whole — their name is their
// spelling.
//
// This used to build a canonical, Optional-SHAPED form: `Nothing` was hoisted
// to a single top-level member and everything else became one payload member,
// so that `Integer | Rational | Nothing` came out as
// `(Integer | Rational) | Nothing` and a Generic bound over `T | Nothing`
// could bind the payload in one piece. An applied `Optional<X>` even
// surrendered its own spelling to merge. All of that existed so that a Union's
// SHAPE could mean "fallible"; a nominal `Optional` says it by name, so the
// canonical form and the invariant it imposed on every caller are gone.
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

// NOTE: The (lhs, rhs) Case pairs whose members are mid-comparison, keyed by
// `lhs` identity — a nested Set so a pair is recognised by both halves. Guards
// the coinductive Case recursion in `matchTypes` against a cyclic payload
// looping forever; entries are added and removed within a single `matchTypes`
// call, so the map is empty between top-level matches.
const activeCasePairs = new Map<common.CaseType, Set<common.CaseType>>()

// NOTE: Whether a Generic name is still OPEN to binding here — bindable AND not
// already pinned to a use of its own name. A SELF-referential binding
// (`ItemType := ItemType`) arises when a callee's bindable Generic shares a
// spelling with the caller's opaque one: a Method generic in `ItemType` calling
// `List.reduce`, whose namespace Generic is also `ItemType`, binds
// `ItemType := ItemType` off the receiver. That pins the callee's Generic to the
// caller's opaque symbol, so from then on it must behave EXACTLY like an opaque
// Generic — matching only another occurrence of itself, and falling THROUGH the
// bindable dispatch so an expected Union can still accept it as a member (the
// `ItemType` arm of a bound `Result` of `ItemType | String`). Left as "open" it
// would instead be chased through its own binding forever.
function isOpenBindable(
	name: string,
	context: GenericInferenceContext | null,
): boolean {
	if (!context?.bindableNames.has(name)) {
		return false
	}

	let binding = context.bindings.get(name)

	return !(
		binding !== undefined &&
		binding.type === "GenericUse" &&
		binding.name === name
	)
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

	// NOTE: A checked refinement flows into anything its BASE flows into — the
	// evidence is simply forgotten, and every value of `NonZeroInteger` is an
	// Integer. This unwrapping sits ahead of Generic binding below on purpose:
	// it is what makes a Type Parameter bind the base, so `T` inferred from a
	// refined Argument is `Integer` and never `NonZeroInteger`. A refined
	// Generic binding (`List<NonZeroInteger>` produced by inference) would
	// carry evidence into positions nothing proved anything about, and it is
	// explicitly not part of v1.
	//
	// NOTE: An expected Union is left to decompose FIRST — unwrapping here
	// would strip the evidence before the Union's own refinement member could
	// read it, so `NonZeroInteger | String` refused the very `NonZeroInteger`
	// it names. Each member then faces the intact refinement: a refinement
	// member by its conjuncts below, any other member through this same
	// unwrapping one level down.
	if (
		rhs.type === "Refinement" &&
		lhs.type !== "Refinement" &&
		lhs.type !== "UnionType"
	) {
		return matchTypes(lhs, rhs.base, context)
	}

	// NOTE: The other direction needs the evidence. A refinement is accepted by
	// a refinement over the same base whose conjuncts INCLUDE its own — proving
	// more than was asked is proof enough, proving less is no proof at all — and
	// by nothing else: a bare Integer arriving where `NonZeroInteger` stands is
	// exactly the mistake the Type exists to name.
	if (lhs.type === "Refinement") {
		if (rhs.type !== "Refinement") {
			return false
		}

		let proven = new Set(provenConjuncts(rhs).map(predicateConjunctKey))

		return (
			matchTypes(lhs.base, rhs.base, context) &&
			provenConjuncts(lhs).every((conjunct) =>
				proven.has(predicateConjunctKey(conjunct)),
			)
		)
	}

	// NOTE: Two opaque Generics of the same name are the same Generic and match.
	// This must NOT short-circuit a Generic still OPEN to binding that happens to
	// share a name with an opaque one: when a Method forwards to another whose
	// `infer` generic is spelled identically — `List`'s Methods all bind
	// `ItemType`, so `firstItem` calling `item(at:)` is `ItemType` matched against
	// `ItemType` — the open side has to reach `matchGenericUse` below and RECORD
	// the binding off the receiver's Type argument, not be waved through here with
	// nothing bound. Once it HAS been bound to its own name it is no longer open,
	// and this is what recognises the two self-pinned `ItemType`s as identical.
	if (
		lhs.type === "GenericUse" &&
		rhs.type === "GenericUse" &&
		lhs.name === rhs.name &&
		!isOpenBindable(lhs.name, context) &&
		!isOpenBindable(rhs.name, context)
	) {
		return true
	}

	// NOTE: Generics can occur on either side — an expected Generic binds the
	// actual Type, while an actual-side Generic occurs when signatures are
	// compared (contravariant parameter positions flip the sides).
	if (lhs.type === "GenericUse" && isOpenBindable(lhs.name, context)) {
		return matchGenericUse(lhs, rhs, context, (binding) =>
			matchTypes(binding, rhs, context),
		)
	}

	if (rhs.type === "GenericUse" && isOpenBindable(rhs.name, context)) {
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

	// NOTE: A bare `List` demands nothing of the items, so it accepts every
	// List. The reverse does NOT hold: a bare `List` PROMISES nothing about
	// them either, and letting one satisfy a `List<Integer>` would hand a List
	// of Strings to everything reading Integers out of it. That direction is
	// what an empty List Literal needs, and it has its own rule below — an
	// Unknown item Type is a slot nothing has decided, not a decision to hold
	// anything at all.
	if (
		lhs.type === "GenericList" &&
		(rhs.type === "GenericList" || rhs.type === "List")
	) {
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
			// Generic binds a nested Union (a `Labelled<Integer | Rational>`'s
			// payload) in one piece; only when no single expected member takes
			// it is a nested actual member decomposed against the whole
			// expected Union, which makes the nested and the flattened
			// spelling of the same Union interchangeable.
			let matchedWholeMembers = true

			for (let rhsType of rhs.types) {
				let foundMatch = false
				// NOTE: Every candidate is tried from the bindings the ones
				// BEFORE it earned, never from the wreckage of a candidate that
				// bound its way down and then failed — see the `else` arm below
				// for what such leftovers do to the candidates after them.
				let attempt = markBindings(context)

				for (let lhsType of lhsMembers) {
					if (matchTypes(lhsType, rhsType, context)) {
						foundMatch = true
						break
					}

					restoreBindings(context, attempt)
				}

				if (!foundMatch && rhsType.type === "UnionType") {
					foundMatch = matchTypes(lhs, rhsType, context)
				}

				if (!foundMatch) {
					matchedWholeMembers = false
					break
				}
			}

			return matchedWholeMembers
		} else {
			// NOTE: Each member is tried on its own. A composite member — a
			// Record, Case or Function mentioning a bindable Generic — can bind
			// Generics on its way down and THEN fail, and those bindings are
			// worth no more than the member that made them: rolled back here,
			// or they decide the members after it. Matching
			// `{ left = "hi", right = 5 }` against
			// `{ left: T, right: String } | { left: String, right: T }` binds
			// `T := String` off the first member's `left`, fails on its
			// `right`, and the second member — which matches on its own with
			// `T := Integer` — was then checked against that leftover `T` and
			// wrongly rejected, so the same call compiled or not depending on
			// the order the Union was written in. Whichever member finally
			// matches keeps the bindings it made.
			let attempt = markBindings(context)

			for (let type of lhsMembers) {
				if (matchTypes(type, rhs, context)) {
					return true
				}

				restoreBindings(context, attempt)
			}
		}

		return false
	}

	// NOTE: Cases are nominal — a Case only matches its own Choice's Case of
	// the same name, never a structurally identical Record (and vice versa).
	// That identity is the entire point of declaring a Choice. Compared by
	// `choiceIdentity` rather than by the Choice's written name, so that two
	// Modules each declaring `choice Result` declare two Types: matched by name
	// their Cases were interchangeable in both directions, with `is` and `match`
	// confusing them and no Diagnostic anywhere.
	// Under generics the tag alone is not enough either: two instantiations of
	// the same Case (`Step<Integer, …>#Done` vs `Step<String, …>#Done`) share a
	// tag but must not be interchangeable, so once the tags agree the payload
	// members are recursed. `typeArguments` are ignored — they are display
	// spelling; the members decide assignability, and recursing them is also
	// what routes a bindable Generic member through `matchGenericUse` (the whole
	// Result inference story).
	if (lhs.type === "Case" && rhs.type === "Case") {
		if (lhs.choice !== rhs.choice || lhs.name !== rhs.name) {
			return false
		}

		// NOTE: The same Case object matches itself in O(1) — every non-generic
		// Choice's Cases keep their identity through `applyGenericBindings`, so
		// this is the entire cost for them. It runs before any pair-guard
		// bookkeeping so that path allocates nothing.
		if (lhs === rhs) {
			return true
		}

		// NOTE: Re-entering the same (lhs, rhs) pair while it is already being
		// compared is the coinductive hypothesis — assume it holds. A genuine
		// counterexample would differ at some finite member path, which is
		// checked before the cycle can close, so assuming the cycle is sound.
		// No cyclic payload should reach here at all: a recursive Type
		// declaration, whether it names itself or goes around a cycle of them,
		// is diagnosed before the hoist and its recursive members resolve to
		// Error. This stays as the guard that makes matching terminate whatever
		// a Type turns out to be built from.
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
			// NOTE: Cases sharing a tag share a declaration, so their member
			// name sets are identical — the length check plus the per-name
			// lookup below assert that strictly rather than trusting it.
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

	// NOTE: A Method NAMED rather than called — `Reader.readsBase`,
	// `Doubler.double` — is a Function value like any other: its receiver
	// already stands as the first Parameter of the Type, and it is emitted as a
	// plain function taking it there. The `SimpleMethod`/`StaticMethod` tag
	// only records where the signature was written down, and no annotation can
	// spell either one, so the three are one kind of value here and only the
	// signature decides.
	// Interchangeable in BOTH directions, because the tag also travels: an
	// unannotated `variable read = Reader.readsBase` is DECLARED
	// `StaticMethod`, and every later assignment to it is measured against
	// that. Waving the tag through in one direction only would refuse a
	// Function literal assigned to that Variable while accepting a Method
	// assigned to the mirrored `variable read = <literal>` — the same Program
	// compiling or not by which of the two happened to be written first.
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

// NOTE: The Argument Type is provided lazily — resolving an Argument's Type
// in the Enricher can report Diagnostics, so `getType` is only invoked for
// Arguments whose label already matched, exactly like the previous inline
// checks did.
// `expectedType` is the parameter's Type with whatever has been inferred so
// far substituted in. A Function literal that omitted its annotations reads
// them off it; every other Argument ignores it entirely.
// `bindings` is the very Map that substitution came from, still being filled —
// what an Argument matched BEFORE the Type Parameters it mentions were decided
// needs, to read its position as it finally stands rather than as it stood the
// moment it was matched. `null` where nothing is being inferred at all.
export type MatchableArgument = {
	name: string | null
	getType: (
		expectedType: common.Type,
		bindings: GenericBindings | null,
	) => common.Type
	// NOTE: Set on an Argument that can bind no Type Parameter of the call it
	// stands in — a prefixed Case construction with no Type Arguments of its own,
	// which is DECIDED by the Parameter it is matched against and decides nothing
	// itself. Said by the Argument rather than read off the Parameter, because a
	// `Box<Item>` Parameter is a Parameter like any other: what can not decide is
	// this way of writing the value, not the place it is written in.
	bindsNothing?: boolean
}

export type ArgumentMatchResult =
	| { type: "Match" }
	| { type: "ArityMismatch" }
	| { type: "ArgumentMismatch"; mismatchedArgumentIndices: Array<number> }

// NOTE: Collects every Type Parameter of THIS invocation that `type` mentions
// — a structural walk, so a Generic buried in a Record member, a List's items
// or a nested signature counts as much as one written at the top. Generics of
// an enclosing definition are opaque symbols here and are not collected: they
// are not what an Argument could bind.
//
// Asked as a search that never finds anything, so that the whole Type is walked
// — collecting is what it is here for, and answering would stop it early.
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

// NOTE: Whether a callback Parameter's own PARAMETERS mention a Type Parameter
// nothing has bound yet — the Types an unannotated Function literal would have
// to read off them. Its return Type is deliberately not asked about: an omitted
// `-> Type` is read off the literal's BODY, so a Generic standing there is one
// the callback BINDS rather than one it waits for, and holding the callback
// back for it would wait for something only it can provide.
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

// NOTE: Whether a Parameter Type mentions a Type Parameter of this call that
// nothing has bound yet — asked of the Parameter an Argument that binds nothing
// stands at, where the whole Type is what the Argument reads, not just the
// Parameters of a callback.
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

// NOTE: The order the Arguments are matched in — their own, except that a
// callback Parameter still waiting on an unbound `infer` Generic is held back
// to the end. An unannotated Function literal is typed FROM the Parameter it
// is passed to, so matching it while that Generic is open makes it echo the
// Generic straight back: the Generic binds to a use of ITSELF, is opaque from
// then on, and every later Argument that could have named a real Type is
// turned away — `apply(transform (x) { <- x }, to 5)` pinned `T` on the
// callback and then refused `5`, its own inferred Type. Matching the Arguments
// that can actually name a Type first means the callback is resolved against
// `(_: Integer) -> Integer` and the invocation reads a real Type throughout.
// Which is why inference must not depend on the order the Parameters happen to
// be written in: the same call with `to 5` first always compiled.
//
// Nothing is deferred without a Generic to wait for, and deferred Arguments
// keep their order among themselves — so a callback is held back behind ANY
// Argument that can still name a Type, another callback (one whose own
// Parameters are already concrete) included.
//
// `null` means "the order they were written in", which is the answer for every
// invocation whose callbacks already come last — every one in the stdlib,
// where `map`'s transform is the final Parameter — so the overwhelmingly
// common case allocates nothing and the loop counts as it always did.
// A prefixed Case construction waits for the same reason and is held back the
// same way: it reads its Choice's Type Arguments off the Parameter it is matched
// against, so a Parameter still mentioning an unbound Generic hands it nothing to
// read and it has to refuse. `unwrap(Box#Empty, 7)` said as much while `7` named
// the very Type one Parameter over — the same order-dependence, on the other kind
// of Argument that is typed BY its position rather than binding it.
function deferredArgumentOrder(
	parameters: common.BaseFunction["parameterTypes"],
	context: GenericInferenceContext | null,
	matchableArguments: Array<MatchableArgument>,
): Array<number> | null {
	if (context === null || parameters.length < 2) {
		return null
	}

	// NOTE: Only a Parameter that FOLLOWS one that waits has anything to gain
	// from being matched first, so an invocation whose waiting Arguments already
	// come last — every Method in the stdlib, `map`'s transform being its final
	// Parameter — is answered here, by a walk that allocates nothing.
	let firstWaiting = parameters.findIndex(
		(parameter, index) =>
			parameter.type.type === "Function" ||
			matchableArguments[index]?.bindsNothing === true,
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
			matchableArguments[index]?.bindsNothing === true &&
			parameterWaitsOnUnboundGeneric(parameter.type, boundSoFar, context)
		) {
			deferred.push(index)

			continue
		}

		immediate.push(index)

		// NOTE: What this Parameter can name is counted as bound for the
		// Parameters after it — a callback waits for the Argument that names its
		// Types, not for one that waits alongside it.
		collectBindableGenerics(parameter.type, context, boundSoFar)
	}

	let order = [...immediate, ...deferred]

	if (order.every((value, position) => value === position)) {
		return null
	}

	return order
}

// NOTE: Checks whether passed Arguments match a parameter list — arity,
// labels (matched by name equality; a labelless Argument only matches a
// labelless parameter), and per-Argument `matchesType`.
// By default the check stops at the first mismatching Argument, which callers
// that only need a boolean "does this overload match" rely on to avoid
// resolving further Argument Types. With `collectAllMismatches` every
// mismatching Argument index is collected, which the Validator uses to report
// one Diagnostic per mismatching Argument — in Argument order, whatever order
// they were matched in.
// With `inference` the Arguments are matched against a Generic signature in
// the order `deferredArgumentOrder` gives — the first occurrence of a bindable
// Generic binds the Argument's Type, later occurrences check against the
// binding. Callers pass a fresh context per overload candidate, so bindings
// can not leak between candidates.
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
	let order = deferredArgumentOrder(
		parameters,
		inferenceContext,
		matchableArguments,
	)

	for (let position = 0; position < parameters.length; position++) {
		let i = order === null ? position : order[position]
		let parameter = parameters[i]
		let argument = matchableArguments[i]

		// NOTE: A callback is matched after the Arguments that bind, so the
		// Generics its Parameters mention have been bound by then —
		// substituting them is what turns `map`'s declared
		// `(_ item: ItemType) -> Result` into the `(_ item: Integer) ->
		// Result` the literal is actually resolved against.
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
				argument.getType(
					expectedType,
					inferenceContext?.bindings ?? null,
				),
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
		// NOTE: Sorted, because a deferred callback may have been matched out
		// of turn — the Validator reports one Diagnostic per index and they
		// must still arrive in the order the Arguments were written.
		return {
			type: "ArgumentMismatch",
			mismatchedArgumentIndices: mismatchedArgumentIndices.sort(
				(left, right) => left - right,
			),
		}
	}

	return { type: "Match" }
}
