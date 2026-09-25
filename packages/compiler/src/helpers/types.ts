import type { common } from "@essence-lang/interfaces"

// NOTE: The suffix the Simplifier mangles an Overload's name with, spelled once
// for the two Functions that write it and read it back.
const OVERLOAD_SUFFIX = "__overload$"

export function resolveOverloadedMethodName(name: string, index: number) {
	return `${name}${OVERLOAD_SUFFIX}${index + 1}`
}

// NOTE: And the inverse: the Overload slot a mangled name names, counting from
// zero, or null where the name carries no suffix at all — which is what a
// Method with one Overload emits. Beside the Function that writes the name,
// because a suffix written in one place and read in another is a suffix two
// places have to agree about.
export function overloadIndexOf(name: string): number | null {
	let suffix = name.indexOf(OVERLOAD_SUFFIX)

	if (suffix === -1) {
		return null
	}

	let index = Number(name.slice(suffix + OVERLOAD_SUFFIX.length))

	return Number.isInteger(index) && index > 0 ? index - 1 : null
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

// NOTE: What a `<-` in a body answers with — the declared Type for every
// ordinary body, and the INNER Type for a completing one. A body that suspends
// is written as though it answered the value, and the future is what the
// emission wraps around it, so `function headline(_ url: String) ->
// Future<String>` returns a String from its `<-`.
//
// NOTE: A completing body whose declaration is not a Future is answered with
// what it declared. The `complete` inside it has been reported already, and
// unwrapping something that is not a future would say the same thing again at
// every `<-`.
export function returnedTypeOf(
	declared: common.Type,
	completing: boolean,
): common.Type {
	return completing && declared.type === "Future"
		? declared.valueType
		: declared
}

// NOTE: What a Type mismatch has to say about ASYNCHRONY, and null wherever it
// has nothing — which is every mismatch in a Program that waits for nothing.
// Three shapes are worth naming, and each is one missing word rather than a
// wrong value:
//
//   - `"unstarted"` — a `Future<T>` stands where its `T` is wanted. The work
//     was described and never run.
//   - `"in-flight"` — a `Started<T>` stands where its `T` is wanted. The work
//     IS running, and nobody waited for it.
//   - `"not-a-future"` — a `T` stands where a `Future<T>` is wanted, which is
//     what a body that declares a future and completes nothing answers with.
//
// Each is decided by assignability rather than by the spelling, so a
// `Future<Integer>` arriving where a String is wanted is a plain mismatch and
// gets none of this: `complete` would not have fixed it.
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
//
// NOTE: The one field it does NOT follow is a display `alias`, on the two Types
// that carry one. Walking whatever is there is what makes this cover shapes
// nobody has added yet, and a display spelling is the one thing on a Type that
// is not part of it: the Type Arguments an `alias` holds are already standing
// wherever they were substituted TO, so following them finds nothing new about
// a Type and finds plenty about a Type Parameter the body never used.
// `type Box<Held> = { value: Integer }` applied as `Box<NonZeroInteger>` holds a
// refinement in its spelling and none in its members — enough, followed, to fail
// the Rewriter's erasure assertion on a Program that erased everything it had.
// The same goes for an Error Argument silencing a second Diagnostic and for an
// unbound Parameter holding an Argument back. A plain `name` is a string and was
// never walked into.
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

		// NOTE: Asked of the FIELD before it is asked of the Type, so that every
		// Type but a spelled one walks exactly as it always did — `entries`
		// allocates a pair per field where `values` allocates a value, and this
		// runs over every Type the Enricher resolves.
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

// NOTE: Substitutes what each Parameter of ONE invocation bound into every
// other binding of that same invocation that still names it, until nothing
// moves. A binding the Arguments produced names no Parameter of the invocation
// and comes back as itself; a `defaultType` PIN is the one that does — a
// provided Method's `Self` is pinned to `List<ItemType>`, and what the
// Arguments made of `ItemType` is what the witness has to be solved for.
//
// Run while the names are still FRESH, which is the whole point: a fresh name
// carries a counter no source Generic can spell and no other invocation shares,
// so substituting this map can not reach a Type Parameter belonging to the
// CALLER. Once `unfreshenBindings` below puts the declared names back, the
// callee's `Key` and the caller's `Key` are one name and the same substitution
// rewrites both — which is exactly the bug this moved the work out of
// `resolveConformances` to fix.
//
// Bounded by the number of bindings: each pass either settles one more name or
// stops. Nothing can declare a pair of Parameters pinned to each other today —
// a `defaultType` naming a sibling is refused where it is written, and the only
// pins the Compiler fabricates name Parameters that carry no pin of their own —
// so the cap is what keeps that a statement about this code rather than a
// promise about the language.
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

// NOTE: Translates the bindings collected against freshened Generic names back
// to the Generics the signature declares, so the return-Type substitution and
// conformance resolution downstream read in the original names. Binding VALUES
// come from the Arguments, which never mention the callee's fresh names — but a
// `defaultType` pin does, so `settlePins` above settles those first, under the
// fresh names that still tell this invocation's Parameters from the caller's.
export function unfreshenBindings(
	bindings: GenericBindings,
	freshToOriginal: Map<common.GenericName, common.GenericName>,
): GenericBindings {
	if (freshToOriginal.size === 0) {
		return bindings
	}

	// NOTE: The usual shape, and the one `bindNamespaceTarget` asks a thousand
	// times over a Program: every binding is a Type the SUBJECT produced, which
	// can mention no fresh name of this invocation, so the two substitutions
	// below have nothing to substitute and only the KEYS change. Asked of the
	// memoised mention set rather than by walking, which is what makes this
	// cheaper than the work it skips — a pin is the one thing that puts a fresh
	// name in a value, and a pin is rare.
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

// NOTE: Whether any binding VALUE names something the translation above would
// rewrite — a Parameter this invocation bound (which is what `settlePins`
// settles) or a fresh name (which is what the reverse rename replaces). False
// means both passes are the identity and only the keys have to move. Asked of
// `mentionedGenericNames`, which remembers its walk per Type object and answers
// the empty Set for everything the Arguments built.
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

// NOTE: A Namespace as the specificity order below sees it — the target Type
// exactly as DECLARED, plus the Generics that are open in it. Never a
// specialized copy: `List<Integer>` specialized out of `List<ItemType>` is
// structurally identical to a hand written `for List<Integer>`, and comparing
// those two would tie where one is strictly narrower.
export type NamespaceTarget = {
	targetType: common.Type | null
	generics: Array<common.GenericDeclaration>
}

// NOTE: A Namespace's own Generics bound from a receiver, in the Namespace's OWN
// names — null where its target Type does not cover that receiver at all. THE
// one door every "does this Namespace target that value" question goes through:
// Method dispatch's candidate set, the specialized target a Diagnostic prints,
// the conformance search, and the specificity order below.
//
// The pattern's Generics are alpha-renamed before the match, exactly as
// `createFreshenedInference` does for a call's Parameters, and the bindings are
// translated back afterwards. The rename itself is remembered per Namespace —
// see `renamedNamespaceTarget`, which is where the reason one set of fresh names
// serves every receiver is written down. Namespaces spell their Generics alike (`ItemType`
// throughout the stdlib, `Item` in a Program) and Generic identity is by NAME,
// so without the rename the pattern's bindable `ItemType` and the subject's
// opaque one are a single symbol. Two things go wrong then, and both are why
// this is one function rather than a rename each caller remembers:
//
//   • `List<List<ItemType>>` binds `ItemType` to a Type mentioning itself, reads
//     as covering `List<ItemType>`, and the two targets tie in the specificity
//     order that has to tell them apart.
//   • A `namespace Pairing<infer Item> for { left: Item, right: Item }` reached
//     from a `via<infer Item>(_ pair: { left: List<Item>, right: List<Item> })`
//     binds `Item := List<Item>` off the FIRST member; the second re-checks
//     `Item` against that binding, and chasing the name through itself never
//     ends. On master that Program spun the Enricher for 363 million
//     `matchGenericUse` turns and never returned. `isOpenBindable`'s occurs
//     check is what makes any such binding terminate; the rename here is what
//     keeps it from arising, so the Namespace is FOUND and the call resolves.
export function bindNamespaceTarget(
	pattern: NamespaceTarget,
	subject: common.Type,
): GenericBindings | null {
	if (pattern.targetType === null) {
		return null
	}

	if (pattern.generics.length === 0) {
		return matchesType(pattern.targetType, subject) ? new Map() : null
	}

	let renamed = renamedNamespaceTarget(pattern.targetType, pattern.generics)
	let context = createInferenceContext(renamed.generics)

	if (!matchesTypeWithBindings(renamed.target, subject, context)) {
		return null
	}

	return unfreshenBindings(context.bindings, renamed.freshToOriginal)
}

// NOTE: The alpha-renamed half of `bindNamespaceTarget` — the Namespace's
// Generics under fresh names, its target Type rewritten to use them, and the way
// back. It depends on the PATTERN alone: the same Namespace against a thousand
// receivers renames once.
type RenamedNamespaceTarget = {
	generics: Array<common.GenericDeclaration>
	target: common.Type
	freshToOriginal: Map<common.GenericName, common.GenericName>
	declaredGenerics: Array<common.GenericDeclaration>
}

// NOTE: Remembered per target TYPE object, because that is the stable half of a
// Namespace here: `solveNamespaceConformance` wraps `{ targetType, generics }`
// in a fresh literal per candidate, so the wrapper is no key at all, while the
// Type it names and the Generics array it hands on are the Namespace's own
// objects and live as long as the analysis does. The entry carries the Generics
// it was built from and is rebuilt when a different array turns up against the
// same Type — two Namespaces can share a target object, and the rename has to
// follow the Generics rather than the Type.
//
// WEAK, and keyed on an OBJECT rather than on a name, because the Language
// Server is a process that outlives any one analysis: a file edited and
// re-enriched builds fresh Types, which are fresh keys, and the entries of the
// analysis it replaced die with it. A `Map` keyed by the Namespace's NAME would
// answer the second analysis with the first one's target.
const renamedNamespaceTargets = new WeakMap<
	common.Type,
	RenamedNamespaceTarget
>()

// NOTE: ONE set of fresh names per Namespace, reused by every question asked of
// it. What makes that sound is what makes the renaming work in the first place:
//
//   • the names are counter-unique — `Item`, a zero-width space and a number
//     that only ever goes up — so no two Namespaces, and no two renames of one
//     Namespace, can ever mint the same name;
//   • no SUBJECT can hold one. Subjects are Types built from source, and the
//     separator is not a character an Identifier may contain; the only place a
//     fresh name exists is inside this pattern and inside the inference context
//     of a match against it, and `unfreshenBindings` translates every binding —
//     keys and values both — back into the Namespace's own names before a single
//     one is returned;
//   • nothing here is written to. Each match makes its own `createInferenceContext`
//     over these declarations, so two questions asked of one Namespace share the
//     pattern and share no bindings.
//
// What would break it is a fresh name ESCAPING into a Type that later comes back
// as a subject — a caller keeping `context.bindings` untranslated, or
// `unfreshenBindings` ceasing to rewrite binding values. The pattern's bindable
// `Item` and a subject's opaque `Item` would be one symbol again, which is the
// collision this renaming exists to prevent and, one level down, the spin
// `isOpenBindable`'s occurs check is the backstop for.
//
// Exported for its guard alone: "one rename per Namespace" is a claim about WORK
// that nothing about an answer can show, since the whole point of the names is
// that none of them is ever seen from outside.
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

// NOTE: Whether `pattern`'s target Type covers `subject` with the pattern's own
// Generics OPEN — `List<ItemType>` covers `List<Integer>` and `List<List<X>>`,
// while `List<List<ItemType>>` covers only the nested one.
function targetCoversAsPattern(
	pattern: NamespaceTarget,
	subject: common.Type,
): boolean {
	return bindNamespaceTarget(pattern, subject) !== null
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

// NOTE: What a declaration throws when it reads something the hoist has not
// reached yet, and the only throw the rounds retry. Like the parser's
// `ParseError` it is not an `Error`, so `toString` gives crash reports its text.
export class NotHoistedYet {
	name = "NotHoistedYet"
	message: string

	constructor(message: string) {
		this.message = message
	}

	toString(): string {
		return this.message
	}
}

// NOTE: During a hoist a predicate still unread asks the rounds to retry its
// reader once the predicate is filled. Outside one nothing is left to fill it,
// so reading it is a Compiler bug.
export function refusePendingPredicate(name: string): never {
	let message = `Internal Compiler Error: the predicate of refinement '${name}' was read before it resolved`

	throw openHoists === 0 ? new Error(message) : new NotHoistedYet(message)
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

	// NOTE: Outside an open hoist no fill is left to complete the copy, so a
	// pending refinement reaching here is a Compiler bug.
	if (openHoists === 0) {
		refusePendingPredicate(source.name)
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
		// NOTE: The one slot a Future has, substituted exactly as a List's item
		// Type is — `Future<Value>` is what a `namespace Future<infer Value>`
		// reads its Parameter off, so a Method of one is resolved by the same
		// machinery every other container's is.
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
		// NOTE: Both slots substituted, and the identity check asks about both:
		// a `Dictionary<String, T>` comes back as itself while `T` is unbound,
		// which is what keeps a Type nothing changed comparing by reference for
		// every reader downstream.
		case "Dictionary": {
			let keyType = applyGenericBindings(type.keyType, bindings)
			let valueType = applyGenericBindings(type.valueType, bindings)

			return keyType === type.keyType && valueType === type.valueType
				? type
				: { type: "Dictionary", keyType, valueType }
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

			// NOTE: The two display fields follow the rule they follow on a
			// Union, one branch up, and for the same reasons: a plain `name`
			// may well spell out the very Type Parameters being replaced, so
			// it is dropped rather than kept stale, while an `alias` carries
			// its Type Arguments as Types and substitutes right along —
			// `Pair<Item>` heals into `Pair<Integer>`. A Parameter-free named
			// Record comes back member by member unchanged and survives
			// through the identity check above, which is what keeps `Standing`
			// spelled `Standing` everywhere a substitution passes it by.
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
					// NOTE: Carried, because it is a fact about the
					// DECLARATION rather than about the instantiation — a
					// generic Choice with no payloads has none whichever
					// Arguments are bound into it. Every other branch of this
					// case spreads the Case whole and keeps it for free; this
					// is the one that rebuilds.
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

// NOTE: Whether every member `promised` says a call may leave out is one
// `supplied` fills in. Both lists are sorted, so this is a merge rather than a
// lookup per name — and the overwhelmingly common answer, two Parameters that
// carry no Record default at all, costs one comparison.
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

		// NOTE: A Parameter the expected signature says may be left out has to
		// be one the actual signature can answer without — a call written
		// against the expected Type omits the Argument, and the emitted call
		// passes `undefined` in its place, which only a Parameter that carries
		// a default of its own consumes. The other direction is safe and is
		// allowed: a call through a Type that promises nothing writes every
		// Argument, and a Function that would have filled one in never has to.
		if (
			expected.parameterTypes[i].hasDefault === true &&
			actual.parameterTypes[i].hasDefault !== true
		) {
			return false
		}

		// NOTE: The same rule one level down. A call written against the
		// expected Type may leave the members the expected Parameter names out
		// of its Record Argument, and only a Parameter whose own default fills
		// those members in can answer it — so every member the expected side
		// promises has to be one the actual side supplies. The other direction
		// is safe and is allowed, exactly as it is for `hasDefault`.
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

// #region Protocol Conformance

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
// answers it, the Method, whether the answer is negated, and the Arguments.
// Assignability between two refinements is set inclusion over these keys, so
// nothing may spell two questions alike. Which is why the separator is a COLON
// and the Arguments are JSON: the Lexer reads `:` as a Symbol, so no name a
// Program can write holds one, and a String Argument — which arrives quoted —
// may hold whatever a joined list's separator would have been.
//
// The leaf is already RESOLVED where it is built, so this compares questions
// rather than spellings: `@::isZero()` and `@::is(0)` key alike, and
// `@::isNot(0)` is the second of those with the flag on. `spelling` is how the
// leaf was written and is deliberately absent — it names the question for a
// reader, it does not decide it.
export function predicateConjunctKey(
	conjunct: common.PredicateConjunct,
): string {
	return `${conjunct.namespaceName}::${conjunct.methodName}:${
		conjunct.negated ? "!" : ""
	}${JSON.stringify(conjunct.args)}`
}

// NOTE: The same leaf asked the other way round. A resolved leaf carries its
// polarity as a flag, so the opposite of one is one field flipped — and the
// spelling goes with the polarity it belonged to: `hasCharacters` is not what
// the contrary of `@::hasCharacters()` is called.
export function negatedPredicateConjunct(
	conjunct: common.PredicateConjunct,
): common.PredicateConjunct {
	let { spelling: _spelling, ...leaf } = conjunct

	return { ...leaf, negated: !conjunct.negated }
}

// NOTE: What a set of leaves proves BESIDES the leaves themselves, as keys. A
// value proven above zero has been proven not to be zero — so a receiver the
// `if` proved `@::isPositive()` of reaches `NonZeroInteger`, which is what a
// reader expects of the two and what comparing the spelled leaves alone does
// not give.
//
// This is the ordering's own law and nothing more, which is what `Comparable`
// promises of its conformers: below, above and equal to one bound exclude each
// other and cover everything. So a leaf excludes the other two, and any two
// exclusions leave the third — the `else` of `@::is(0)` and the `else` of
// `@::isLessThan(0)` between them say the value is above zero. `isBetween` is
// the same statement about two bounds at once, and says nothing at all when the
// bounds enclose nothing.
//
// It is the SAME Argument throughout. `@::is(5)` says plenty about zero as
// well, and every one of those would have to be worked out against every
// literal any refinement in scope mentions — so what is here is the closure a
// set carries on its own, which can not grow with the Program.
//
// NOTE: The Methods are named, but only where the base itself answers them.
// `is`, `isLessThan` and `isGreaterThan` are `Equatable`'s and `Comparable`'s
// vocabulary, and `isBetween` is `Orderable`'s, and the ordering's law is a promise the BASE makes —
// so a leaf is read for it only when the Namespace that answered is the base's
// own, or the covering `Number` an Integer bound on a Rational falls to. A
// Program may declare `namespace Tally for String { isLessThan(_ n: Integer) … }`
// and mean something else entirely by the word, and reading the law off that
// would rule out comparisons nobody made. It is `narrowedBy`'s guard, spelled
// once more, and it costs the standard library nothing: every conjunct there is
// `Integer::`, `Rational::`, `String::`, `List::` or `Number::`.
//
// Remembered against the conjuncts ARRAY rather than the refinement, because
// that array is the object the two-stage fill writes into every copy of an
// Alias — so the declared `NonEmptyList<Item>` and every instantiation of it
// share one answer, which is exactly what a memo wants. Assignability asks this
// on a hot path and used to build a fresh Set at every call. The BASE is in the
// key as well, because the answer is now a question about the two together.
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

// NOTE: Whether the Namespace that answered a leaf is one the base's own
// ordering speaks through — the base's Namespace, or the covering `Number` a
// bound of the other numeric kind falls to. Anything else is a Program's own
// word for something, and says nothing about below, above and equal.
export function answersForBase(
	conjunct: common.PredicateConjunct,
	tag: string,
): boolean {
	return namespaceAnswersForBase(conjunct.namespaceName, tag)
}

// NOTE: The same question asked of a NAME alone, which is what reading a body
// has instead of a leaf: the Enricher decides whether a flipped call may be
// read as the ordering's converse before it has a conjunct to ask about.
export function namespaceAnswersForBase(
	namespaceName: string,
	tag: string,
): boolean {
	return namespaceName === tag || namespaceName === "Number"
}

// NOTE: The tag of the Type a refinement is written ON. A refinement of a
// refinement carries its own base one level in, and a generic Alias carries the
// refinement one level in — so both are walked through to the Integer, Rational,
// String or List underneath. Anything else answers as itself, which no conjunct's
// Namespace is ever named after, and so trusts nothing.
export function refinableBaseTag(type: common.Type): string {
	let current = type

	while (current.type === "Refinement" || current.type === "GenericAlias") {
		current =
			current.type === "Refinement" ? current.base : current.aliasedType
	}

	return current.type
}

// NOTE: The two comparisons one leaf rules out, over its own Argument.
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

		// NOTE: The two bounds name the same range in either order, which is
		// what the standard library's own body says — so a pair written the
		// other way round is read with the two exchanged, rather than as a
		// contradiction nothing may be read off.
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

// NOTE: The comparison two EXCLUSIONS over one bound leave standing. The three
// cover everything between them, so ruling out two proves the third: the `else`
// of `@::is(0)` and the `else` of `@::isLessThan(0)` say nothing apiece and say
// "above zero" together.
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

// NOTE: The three comparisons over one bound, each mapped to the other two. Read
// in one direction it is what a leaf rules out, and in the other what two ruled
// out leave standing.
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

// NOTE: A bound as the exact number it is — a run of digits, or two of them
// with a slash between, which is what a Rational receiver's conjunct keeps. The
// two are only ever COMPARED here, so the pair is kept rather than divided, and
// a negative denominator is moved onto the numerator so the cross-multiplication
// keeps the order.
//
// The reader is written out again rather than borrowed from `predicateEval`,
// which reads the same two forms: that module is the one that DECIDES a
// predicate and it imports this one, so the borrowing would have to run the
// other way round.
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

// NOTE: The one door to a refinement's conjuncts. They are null while a refined
// Alias waits for the Namespace answering its predicate to hoist, and nothing
// may be decided about a predicate nobody has read, so the null is refused.
export function provenConjuncts(
	refinement: common.RefinementType,
): Array<common.PredicateConjunct> {
	if (refinement.conjuncts === null) {
		refusePendingPredicate(refinement.name)
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
// Dictionary's keys and values, a Record's members, a Union's arms — which is
// also what keeps a Choice's self-referential payload from looping.
export function typeContainsUnknown(type: common.Type): boolean {
	switch (type.type) {
		case "Unknown":
			return true
		case "List":
			return typeContainsUnknown(type.itemType)
		// NOTE: And the two asynchronous containers, whose open slot no Program
		// can write — a bare `Future` is refused where it is spelled, and no
		// Expression builds one out of nothing. So the answer here is about the
		// Compiler's own Types: a Future nobody decided the answer Type of is
		// undecided, full stop, whichever stage was holding it.
		case "Future":
		case "Started":
			return typeContainsUnknown(type.valueType)
		// NOTE: Either slot undecided leaves the Type undecided — there is one
		// answer to "is anything here still open?", and two slots to ask it of.
		// `GenericDictionary` is left out for the reason a bare `List` is: its
		// Unknowns are DECLARED defaults, not slots waiting on an answer.
		case "Dictionary":
			return (
				typeContainsUnknown(type.keyType) ||
				typeContainsUnknown(type.valueType)
			)
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

// NOTE: Whether a value written into a slot nothing has decided DECIDES it.
// Anything that is not itself a blank does, with one exception: a Type carrying
// an Error decides nothing. Whatever produced that Error was reported where it
// came from, and an Error is poison everywhere else for the same reason —
// pinning a slot to one would spread a single mistake over every later use of
// the name, and REFUSING the write would report that mistake a second time.
//
// One question, asked by both halves of the rule: `resolveUnknownSlots` fills a
// slot where this holds, and `matchTypes` refuses a write where it holds and the
// slot is still open. Asking it in only one of the two places is what made
// `{ box with items = box.items::append(undeclared) }` a
// `partial-type-mismatch` stacked on top of the name that is not declared.
export function decidesAnUndecidedSlot(written: common.Type): boolean {
	return written.type !== "Unknown" && !typeContainsError(written)
}

// NOTE: The Type with every proof taken off it, however deep one sits — the
// shape a decision is allowed to be. It enumerates the places a Type ARGUMENT
// can stand, the same list `typeContainsUnknown` walks and for the same reason:
// those are the positions a value's own Type reaches, and stopping there is what
// keeps a Choice that names itself from looping. A Type holding no refinement at
// all comes back as itself, so a decision that changes nothing is recognisable
// by identity, which is how every caller here tells a pin from a no-op.
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
		// NOTE: A rebuilt Record drops its own display spelling for the same
		// reason the Union below drops its arms' — a `Standing` whose
		// `NonZeroInteger` member erased to an Integer declares something
		// `Standing` does not, and a shape is not the Alias it stopped being.
		// One holding no refinement anywhere comes back as itself and keeps it.
		case "Record": {
			let members: Record<string, common.Type> = {}
			let stripped = false

			for (let [name, memberType] of Object.entries(type.members)) {
				members[name] = withoutRefinements(memberType)
				stripped ||= members[name] !== memberType
			}

			return stripped ? { type: "Record", members } : type
		}
		// NOTE: The name and the alias go with the arm they described, exactly as
		// they do wherever else an arm is rebuilt — `NonEmptyList<String> | X` is
		// not what a Union whose first arm is now a plain List is called.
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

// NOTE: The Type with a Record's display spelling taken off it, however deep one
// sits — what a Type looks like to anything that is not a reader. A descriptor is
// DATA the runtime consults, and `Standing` says nothing about a value that
// `{ team: …, played: … }` does not; emitted, it would put a name the runtime has
// never heard of into every Program that matches on an Alias, and split the
// constant pool between two spellings of one shape. So the Rewriter strips it on
// the way out, which is also what keeps the emitted JavaScript byte for byte what
// it was before Records could be named at all.
//
// A Union's own `name` and `alias` are deliberately LEFT — they reach an emitted
// descriptor today, inert, and taking them out here would change the output this
// is written to keep identical. The one new field is the one that goes.
//
// NOTE: Identity-preserving, like every walk here: a Type holding no named Record
// comes back as itself, so the common descriptor allocates nothing. The visiting
// set is the back-edge guard `resolveUnknownSlots` carries.
//
// A back edge is answered with the type UNSTRIPPED, which is defence rather than
// an answer that arises: the Enricher refuses a Type declaration that names
// itself, directly or around a cycle. The guard keeps a Language Server that
// walks into a cycle from hanging.
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
				// NOTE: The Type ARGUMENTS of a Union's or a Case's applied
				// spelling are stripped alongside its members, because a
				// spelling is printed too: `Optional<Standing>` is the word a
				// reader recognises in a Diagnostic and `Optional<{ … }>` is
				// what the embedding boundary has to say, and both are read off
				// these. A Refinement's are stripped for the same reason, and
				// its base along with them.
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
				// NOTE: Walked through as well, because a Function Type is DATA
				// in a descriptor like any other and a Record standing in one of
				// its Parameters is still a Record nobody can name at run time.
				// The one field `isValueOfType` reads of a Function is that it
				// is one, so what is left in the signature is bytes — and bytes
				// that differ from the ones this was emitting before.
				case "Function":
				case "SimpleMethod":
				case "StaticMethod": {
					let signature = strippedSignature(type, strip)

					return signature === type ? type : { ...type, ...signature }
				}
				// NOTE: An Overload set is those signatures in a list, and a
				// Record standing in one of them is as nameless as one in a
				// plain Function's. Nothing emits an Overload set today — the
				// descriptor path can not reach here — but this walk answers
				// the embedding boundary too, which PRINTS what it is given,
				// and a list of the shapes it happens to be asked about is the
				// kind of list that goes quietly out of date.
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

// NOTE: The same answer for a signature, which is what the embedding boundary
// asks — `printSignature` takes a `BaseFunction`, and a `BaseFunction` carries no
// `type` field to discriminate on, so the walk above can not hand one back. This
// is that walk's Function case, shared rather than written twice.
export function withoutRecordNamesInSignature(
	signature: common.BaseFunction,
): common.BaseFunction {
	return strippedSignature(signature, withoutRecordNames)
}

// NOTE: A list of Type Arguments stripped, answering the very list it was given
// where nothing changed — which is how each branch above tells a Type it has to
// rebuild from one it can hand back.
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

// NOTE: `stored` with every Unknown slot `value` has an answer for filled in —
// what turns `variable items = []` into a List of Integers the moment
// `items = [1, 2]` says so. Only slots that are Unknown are touched, so a Type
// that already decided something keeps it and the caller can tell that nothing
// was pinned by getting the very same Type back.
export function resolveUnknownSlots(
	stored: common.Type,
	value: common.Type,
): common.Type {
	// NOTE: The Types being walked. The Enricher refuses a Type declaration
	// that names itself, so meeting one of them again is defence only.
	let visiting = new Set<common.Type>()

	let resolve = (stored: common.Type, written: common.Type): common.Type => {
		if (stored === written || visiting.has(stored)) {
			return stored
		}

		// NOTE: A DECISION never carries a refinement, at any depth. A slot
		// decided by inference holds many values over the life of the name that
		// owns it — a fold's accumulator, a Dictionary's values, a List's items —
		// and a refinement is a proof about ONE value. Pinning the proof into the
		// slot makes the next write of an unrefined value impossible, and that
		// write is usually the fold's own: `[current with word = []::append(word)]`
		// decides the values `NonEmptyList<String>`, and then the
		// `current::value(at key, defaultingTo [])` that BUILT it no longer fits
		// its own Dictionary. An author who wants the proof in the slot annotates,
		// which is the one place a Type is stated rather than inferred.
		//
		// This reverses the reading inherited from master, where a slot took the
		// written Type whole. That reading was invisible while an undecided slot
		// accepted everything; a slot that now refuses what does not fit it has to
		// hold the Type the name can keep writing, not the Type one write proved.
		if (stored.type === "Unknown") {
			return decidesAnUndecidedSlot(written)
				? withoutRefinements(written)
				: stored
		}

		// NOTE: A refinement standing over the CONTAINER whose slots are being
		// filled is looked through instead, and its evidence dropped:
		// `variable items = []` followed by `items = items::append("a")` pins a
		// `List<String>`, never the `NonEmptyList<String>` the call answered.
		// The refinement is proof about THAT value, and `stored` is the Type of
		// a name whose earlier value — the empty List — was not refined at all,
		// so keeping it would put a Type on the name that its own Declaration
		// never satisfied. The slots underneath are still the value's, which is
		// why the rule stops at this one level. Refinements nest, so the walk
		// does too.
		let value = written

		while (value.type === "Refinement") {
			value = value.base
		}

		// NOTE: A written Union is asked member by member, because a value built
		// out of branches says what it holds in the branches that WRITE into the
		// accumulator and nothing at all in the ones that hand it back untouched.
		// `if number::isLessThan(0) { <- kept }` beside `<- kept::append(number)`
		// answers `NonEmptyList<Integer> | List<Unknown>`: one member decides the
		// item Type, the other is the blank the seed came in as, and reading the
		// two together decides nothing. Asked separately and merged slot-wise,
		// the blank takes the answer the members that have one agree on — which
		// is also what lets a Record seed decide one member per branch, as
		// `{ evens = [], odds = [] }` does.
		//
		// Before `visiting`, so the members can each be walked against the very
		// `stored` this call is resolving. What guards the recursion instead is
		// the written side shrinking: every member is smaller than the Union it
		// came from, and a Type is a finite tree.
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

			// NOTE: The one slot each, pinned the way a List's item Type is.
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

			// NOTE: Each slot pinned INDEPENDENTLY, which is the whole of what
			// a second slot changes here: a `Dictionary<Unknown, Unknown>` that
			// meets a `Dictionary<String, Unknown>` keeps its undecided values
			// and gains its keys. Nothing may read one slot from the other.
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

// NOTE: What several readings of the same `stored` AGREE its blanks are, slot by
// slot. Each candidate is `stored` with some of its blanks filled — one per
// member of a written Union — so every one of them has its shape, and each blank
// is answered by the candidates that HAVE an answer for it: a branch handing the
// accumulator back untouched says nothing about it, and the branch appending to
// it says everything, so one branch is enough to decide a slot.
//
// Two candidates answering the same blank DIFFERENTLY leave it blank. There is
// no one Type the value holds, and picking either would be picking the branch
// that happens to be written first — so the slot stays open and the write is
// refused with the note that says nothing decided it, which is the truth about a
// fold whose branches disagree.
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

	// NOTE: Member by member, which is what a seed holding two accumulators
	// needs: `{ evens = [], odds = [] }` is written one member per branch, so
	// neither branch decides the Record and both together decide every member.
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

	// NOTE: Arm by arm and by POSITION, because every candidate came out of the
	// same `stored` — a Union whose arms were rebuilt still has them in the order
	// it had them in, and a candidate that is not that Union at all decided
	// nothing about its arms.
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

// NOTE: A Simple requirement is fulfilled by a Simple Method or by the first
// matching overload of an Overloaded one — mirroring how invocations resolve
// their overload. Staticness must agree; the emitted name of the fulfilling
// Method (with its own overload suffix) and the Method itself are returned, the
// latter so its own Protocol bounds can be inspected.
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
	return matchTypes(lhs, rhs, null, OUTERMOST)
}

// NOTE: Whether `part` says only things `whole` already declares — every member
// of `part` is a member of `whole`, carrying a value the member's declared Type
// admits. It is what a `with` right-hand side has to be, and it is not
// assignability in either direction: `matchesType(whole, part)` asks the
// opposite question (does `part` answer everything `whole` promises), and
// `matchesType(part, whole)` reads the member Types the wrong way round.
//
// NOTE: Judged by assignability, not by identity — an update sets a member
// to a VALUE, and a value of one arm is enough for a Union-typed member,
// exactly as it is at the Declaration. Deep equality refused `{ c with
// n = 5 }` against a declared `Integer | String`, and told two spellings
// of one Union apart.
//
// NOTE: `context` is threaded to the member comparisons so a caller that is
// INFERRING can ask this — the partial fit of an Argument against a Parameter
// whose Type is still binding Generics. A caller with nothing to bind passes
// nothing, which is `matchesType`'s own `null`.
export function isPartialOf(
	whole: common.RecordType,
	part: common.RecordType,
	context: GenericInferenceContext | null = null,
): boolean {
	for (let [partName, partMemberType] of Object.entries(part.members)) {
		// NOTE: `Object.hasOwn` before the read — a member named after one
		// of `Object.prototype`'s would otherwise be compared against a
		// JavaScript function the Record does not have.
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

// NOTE: The Type a Record Literal carrying path keys HAS once the default it is
// merged into has filled the rest in. A member a path key wrote stands for the
// WHOLE member the merge rebuilds — `{ server.port = 1 }` carries a `server` of
// Type `Server`, because the callee reads `port` off the Argument and every
// other member off the default — so that is the Type it answers for one, and
// every reader of a partial Literal goes on asking the one question it asked
// before: is this a partial of what the position declares.
//
// `null` where there is nothing to answer — a value that is no Record Literal,
// or one that wrote no path key — and where the merge does not hold: a step the
// default does not reach into, one the position declares at another Type, or a
// level whose own members the declared Type refuses. There the Literal is what
// it says it is, the position turns it away, and the Diagnostic names the path.
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

// NOTE: A level a path key built, which is a partial of the member it stands
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

		// NOTE: `Object.hasOwn` before either read — a member named after one of
		// `Object.prototype`'s would otherwise find a JavaScript function where
		// the Record has nothing, and a nesting that names nothing.
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

		// NOTE: The level has to be a PARTIAL of the member it merges into,
		// which is the very question the whole Literal is asked one level up —
		// every member it writes is one that member declares, at a Type that
		// member admits. What it leaves out is what the default fills in, and a
		// default fills in every member of a Record it writes as a Literal.
		if (inner === null || !isPartialOf(declaredType, inner, context)) {
			return null
		}

		members[name] = declaredType
	}

	return { type: "Record", members }
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

	if (
		(left.type === "Future" && right.type === "Future") ||
		(left.type === "Started" && right.type === "Started")
	) {
		return isLessSpecific(left.valueType, right.valueType)
	}

	// NOTE: Slot-wise, and it takes only ONE slot to say less — a
	// `Dictionary<Unknown, Integer>` beside a `Dictionary<String, Integer>`
	// spells less out and yields to it, exactly as the empty List's placeholder
	// yields to the concrete item Type beside it.
	if (left.type === "Dictionary" && right.type === "Dictionary") {
		return (
			isLessSpecific(left.keyType, right.keyType) ||
			isLessSpecific(left.valueType, right.valueType)
		)
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
	return matchTypes(lhs, rhs, context, OUTERMOST)
}

// NOTE: The (lhs, rhs) Case pairs whose members are mid-comparison, keyed by
// `lhs` identity — a nested Set so a pair is recognised by both halves. Guards
// the coinductive Case recursion in `matchTypes` against a cyclic payload
// looping forever; entries are added and removed within a single `matchTypes`
// call, so the map is empty between top-level matches.
const activeCasePairs = new Map<common.CaseType, Set<common.CaseType>>()

// NOTE: The Generic names a binding mentions, remembered per Type object. The
// question is asked of one binding on every later occurrence of its Parameter,
// so one walk per distinct binding is the whole cost. A remembered answer never
// misses a name because no edit made in place adds one: filling in a
// refinement's predicate adds none, and poisoning a refinement into its base
// can only drop the names the refinement's own spelling carried. Keyed by the
// binding rather than by the context, because the same Type is bound under
// many. The answer is almost always the empty Set, which is what makes the
// chase below free.
const bindingMentionsMemo = new WeakMap<common.Type, Set<common.GenericName>>()

function mentionedGenericNames(binding: common.Type): Set<common.GenericName> {
	let remembered = bindingMentionsMemo.get(binding)

	if (remembered === undefined) {
		remembered = genericNamesMentioned(binding)
		bindingMentionsMemo.set(binding, remembered)
	}

	return remembered
}

// NOTE: Whether following a Parameter's binding, and the bindings of everything
// that binding mentions, leads back to the Parameter itself. THE occurs check,
// written over the whole binding graph rather than over one edge of it: the
// plain shape is `Item := List<Item>`, but two Parameters can hold each other
// instead — `Key := List<Value>` beside `Value := List<Key>` — and a check that
// only read its own binding waved that pair through and let the matcher chase
// the pair around forever. Neither cycle stands for any finite Type, so a
// Parameter caught in one is no longer open to binding.
//
// Bounded by the bindable names, which are one invocation's Type Parameters:
// a handful, and the walk stops at the first binding that mentions nothing.
function bindingCyclesBackTo(
	name: common.GenericName,
	context: GenericInferenceContext,
): boolean {
	// NOTE: The answer for very nearly every binding, and worth its own line
	// because this is asked on EVERY later occurrence of a bound Parameter: a
	// Type the Arguments produced mentions no Generic at all, so there is
	// nothing for the walk below to follow. Reading that off the memoised
	// mention set costs two lookups, where discovering it by walking costs a Set
	// and a queue per question.
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

// NOTE: Whether a Generic name is still OPEN to binding here — bindable AND not
// already pinned to a Type that MENTIONS its own name. Such a binding arises
// when a callee's bindable Generic shares a spelling with the caller's opaque
// one, and the two are one symbol because Generic identity is by name. The plain
// case is `ItemType := ItemType`: a Method generic in `ItemType` calling
// `List.reduce`, whose namespace Generic is also `ItemType`, binds it off the
// receiver. That pins the callee's Generic to the caller's opaque symbol, so
// from then on it must behave EXACTLY like an opaque Generic — matching only
// another occurrence of itself, and falling THROUGH the bindable dispatch so an
// expected Union can still accept it as a member (the `ItemType` arm of a bound
// `Result` of `ItemType | String`). Left as "open" it would instead be chased
// through its own binding forever.
//
// NOTE: The occurs check is the whole rule, not just the `X := X` shape it was
// first written for, and it is asked of the binding GRAPH — see
// `bindingCyclesBackTo`. `Item := List<Item>` is the same collision one level
// down —
// a `namespace Pairing<infer Item> for { left: Item, right: Item }` reached from
// a Function whose own Parameter is also spelled `Item`, over a receiver of
// `{ left: List<Item>, right: List<Item> }`. The FIRST member records the
// binding, the SECOND re-checks `Item` against it, and chasing `Item` through
// `List<Item>` never ends: on master that program spun the Enricher for
// 363 million `matchGenericUse` turns with flat memory and never returned. No
// finite Type satisfies `Item = List<Item>`, so treating the Parameter as the
// opaque symbol it was pinned to is both terminating and the honest reading; the
// collision itself is kept from arising in the first place by alpha-renaming a
// Namespace's Generics before its target is matched, and this is the backstop
// that holds for every spelling, including ones no rule anticipates.
function isOpenBindable(
	name: string,
	context: GenericInferenceContext | null,
): boolean {
	if (!context?.bindableNames.has(name)) {
		return false
	}

	return !(context.bindings.has(name) && bindingCyclesBackTo(name, context))
}

// NOTE: Whether a Type Parameter already stands for a refinement. A Parameter
// binds the BASE wherever a value is measured against it, so this is only ever
// true of one bound from INSIDE a Type — `ItemType` off a
// `List<NonEmptyList<Integer>>` receiver — or of one an author applied by hand.
// Either way it is a proof somebody wrote down, and the comparison belongs
// against it rather than against what it narrows.
function refinementBoundTo(
	type: common.Type,
	context: GenericInferenceContext | null,
): boolean {
	if (type.type !== "GenericUse" || !isOpenBindable(type.name, context)) {
		return false
	}

	return context?.bindings.get(type.name)?.type === "Refinement"
}

// NOTE: Where in a Type the comparison currently stands. `OUTERMOST` is the
// whole of what a position asks — an Argument against its Parameter, a value
// against its Declaration — and `NESTED` is everything reached by going THROUGH
// a Type: a List's items, a Record's or a Case's members, a signature's
// Parameters. Only one rule reads it, the refinement unwrapping below, and only
// the reason it gives there makes the distinction worth carrying.
type MatchDepth = "outermost" | "nested"

const OUTERMOST: MatchDepth = "outermost"

const NESTED: MatchDepth = "nested"

function matchTypes(
	lhs: common.Type,
	rhs: common.Type,
	context: GenericInferenceContext | null,
	depth: MatchDepth,
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
	// it is what makes a Type Parameter bind the base at the OUTERMOST position,
	// so `T` inferred from a refined Argument is `Integer` and never
	// `NonZeroInteger`. That rule is what keeps a Generic standing for a value
	// the call THREADS from being pinned to evidence the thread does not carry:
	// a `loop(startingWith nonZero, step …)` whose step answers an ordinary
	// Integer is a Program that works, and binding `State` to `NonZeroInteger`
	// off the seed would refuse it.
	//
	// NOTE: A refinement standing INSIDE another Type is a different matter, and
	// binds as itself. Nobody inferred it there — `List<NonEmptyList<Integer>>`
	// says what it says because something wrote it down or because a Method
	// promised it, and the item Type is not a place a later value can widen. So
	// `groups::firstItem()` answers `Optional<NonEmptyList<Integer>>` and the
	// proof survives being a Type Argument, while the outermost rule above is
	// untouched.
	//
	// NOTE: An expected Union is left to decompose FIRST — unwrapping here
	// would strip the evidence before the Union's own refinement member could
	// read it, so `NonZeroInteger | String` refused the very `NonZeroInteger`
	// it names. Each member then faces the intact refinement: a refinement
	// member by its conjuncts below, any other member through this same
	// unwrapping one level down.
	//
	// NOTE: And not where the Type Parameter is already BOUND to a refinement,
	// wherever it stands. There is nothing left to infer there — the Parameter
	// stands for a proof already, and unwrapping would ask a proven Argument to
	// fit the base and then refuse it for being proven. It is what a Method
	// whose Parameter is the item Type meets on a proven item Type:
	// `groups::append(proven)` and `groups::contains([9])` both hand a
	// `NonEmptyList<Integer>` to an `ItemType` bound to one.
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

	// NOTE: The other direction needs the evidence. A refinement is accepted by
	// a refinement over the same base whose conjuncts INCLUDE its own — proving
	// more than was asked is proof enough, proving less is no proof at all — and
	// by nothing else: a bare Integer arriving where `NonZeroInteger` stands is
	// exactly the mistake the Type exists to name.
	//
	// "Include" reads the leaves the other side proves BESIDES the ones it
	// spells — see `impliedConjunctKeys`. A value proven above zero has been
	// proven not to be zero, and a Type saying so has to reach the Namespace
	// that asks for exactly that.
	//
	// NOTE: A Generic that is already BOUND is not "nothing else" — it stands
	// for whatever it was bound to, and the comparison belongs against that. It
	// is reached when a Type Parameter has picked a refinement up out of a Type
	// Argument and the same Parameter comes back round in a flipped position:
	// `groups::map((inner) { … })` binds `ItemType` to `NonEmptyList<Integer>`
	// off the receiver, and the lambda's own Parameter — typed from that very
	// binding — is then measured against `ItemType` with the sides swapped.
	// Refused here it made the call unresolvable. An UNBOUND Generic still gets
	// nothing from this side: a refinement does not bind a Type Parameter from
	// the actual side of a signature, which is the outermost rule above read in
	// the mirror.
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
			matchTypes(binding, rhs, context, depth),
		)
	}

	if (rhs.type === "GenericUse" && isOpenBindable(rhs.name, context)) {
		return matchGenericUse(rhs, lhs, context, (binding) =>
			matchTypes(lhs, binding, context, depth),
		)
	}

	// NOTE: An opaque Generic is a symbol of an enclosing definition — as the
	// expected Type it only accepts itself, which the same-name check above
	// already covered. As the actual Type it falls through, so that an
	// expected Union can still accept its own Generic member.
	if (lhs.type === "GenericUse") {
		return false
	}

	// NOTE: `Unknown` as the WHOLE expected Type accepts everything, and stays
	// that way. No author wrote it — `Unknown` is unspellable in Essence — so
	// the only place it can stand here is an answer the Compiler had nothing
	// better to give: a `case _` with nothing left to catch
	// (`resolveWildcardMatcherType`), a member read off a Type that has no such
	// member (`memberTypeOf`), an Alias whose body could not be resolved
	// (`aliasBodyType`). Each of those has already been reported or has nothing
	// to report, and refusing them here would pile a second Diagnostic on top
	// of every one. Outermost error recovery is the whole of the list: a bare
	// `Future` or `Started` used to reach here as well, and is refused where it
	// is written instead, because it was a spelling that minted VALUES of this
	// Type and no recovery at all.
	//
	// NOTE: The undecided SLOT of a container is a different question and has
	// its own rules below — the Unknown a `[]` or a `[=]` leaves behind is a
	// blank waiting to be filled, and a value written into it decides it.
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
		// NOTE: An undecided item Type is a SLOT, and a slot may be READ as
		// bottom but never WRITTEN into without being decided. Accepting a
		// decided List here did both at once: `List<Unknown>` took a List of
		// Strings and remained a `List<Unknown>` afterwards, which fits every
		// List in turn — so the items came back out as Integers and every
		// Number Method ran on Strings. Whoever owns the slot decides it before
		// the question is asked (an assignment, a Record update, the seed of a
		// Type Parameter); a slot that reaches here still undecided is one
		// nothing in the Program ever filled, and the write is refused.
		if (
			lhs.itemType.type === "Unknown" &&
			decidesAnUndecidedSlot(rhs.itemType)
		) {
			return false
		}

		// NOTE: Empty List Literals have an Unknown itemType and
		// are assignable to any List.
		if (rhs.itemType.type === "Unknown") {
			return true
		}

		return matchTypes(lhs.itemType, rhs.itemType, context, NESTED)
	}

	// NOTE: The bare-container rule again, unchanged by the second slot — a
	// bare `Dictionary` demands nothing of either, so it accepts every one, and
	// the reverse direction is the Unknown-slot rule below rather than this one.
	if (
		lhs.type === "GenericDictionary" &&
		(rhs.type === "GenericDictionary" || rhs.type === "Dictionary")
	) {
		return true
	}

	if (lhs.type === "Dictionary" && rhs.type === "Dictionary") {
		// NOTE: The write rule above, asked per slot: an undecided key or value
		// Type refuses a Dictionary that has decided that slot, and the other
		// slot has no say in it. Both halves matter — a Dictionary whose keys
		// were decided and whose values were not still launders its values —
		// and neither can be answered by the slot beside it.
		if (
			(lhs.keyType.type === "Unknown" &&
				decidesAnUndecidedSlot(rhs.keyType)) ||
			(lhs.valueType.type === "Unknown" &&
				decidesAnUndecidedSlot(rhs.valueType))
		) {
			return false
		}

		// NOTE: The empty-List rule applied to each slot SEPARATELY. An empty
		// Dictionary decides neither, so it is assignable to any Dictionary the
		// way an empty List Literal is assignable to any List — and a slot that
		// was decided is still checked, so a `Dictionary<Unknown, Integer>`
		// fits `Dictionary<String, Integer>` and not `Dictionary<String,
		// String>`. Reading the two slots together would have made a
		// half-decided Dictionary either wholly opaque or wholly checked, and
		// both throw away what the other slot says.
		let keysMatch =
			rhs.keyType.type === "Unknown" ||
			matchTypes(lhs.keyType, rhs.keyType, context, NESTED)

		return (
			keysMatch &&
			(rhs.valueType.type === "Unknown" ||
				matchTypes(lhs.valueType, rhs.valueType, context, NESTED))
		)
	}

	// NOTE: Covariant in the one slot, which is the only variance a Future can
	// have: it is a producer and nothing ever writes a value INTO one. There is
	// no bare spelling to give a rule of its own — a written `Future` is refused
	// for the Type Argument it left off — so the slot reaching here still open
	// is the Compiler's own recovery, and the Unknown rule reads it as one.
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
				if (matchTypes(type, rhs, context, depth)) {
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
			// NOTE: `Object.hasOwn` before the read — a member named after one
			// of `Object.prototype`'s would otherwise be compared against a
			// JavaScript function the Record does not have.
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
	// NOTE: The Argument's enriched value where there is one, so a Record
	// Literal that wrote a path key can be measured by what the merge makes of
	// it rather than by what it says on its own. Answered lazily: an Argument is
	// enriched at most once per Invocation, and this is asked once per candidate.
	mergedValue?: () => common.typed.ExpressionNode | null
	// NOTE: Fills the Unknown slots of this Argument's own Type from the Type the
	// finished call decided for the Parameter it stands at — the brackets of a
	// written `[]` taking what the call worked out for them. Absent everywhere the
	// Argument has no Node to write onto: the Validator matches typed Nodes, and
	// what it reads there is a decision the Enricher has already made.
	decide?: (decided: common.Type) => void
	// NOTE: Set on an Argument written as a Record LITERAL, whose emitted value
	// therefore carries exactly the members its Type names and no others.
	//
	// NOTE: Which is what a PARTIAL Argument has to promise, and why only a
	// literal may be one. Record assignability is width subtyping, so a value
	// typed `{ host: String }` may carry a `retries` of any Type at all — and a
	// callee filling in the members a caller left out reads
	// `options.retries ?? 3`, which would take that foreign value for the member
	// it is missing, exactly as spreading a `with`'s right-hand side whole did.
	// A literal has nothing to hide: its Type is its text. Every OTHER
	// expression still passes a WHOLE Record, where every member the callee
	// reads is one the Type declares and the fallback can not fire at all.
	spellsItsMembers?: boolean
}

// NOTE: Which Argument each Parameter was given. `forParameter[i]` is the
// Argument index paired with Parameter `i`, or null when the Parameter took its
// default; `omittedParameterIndices` is the same fact the other way round, and
// is what rides out to the emission side. Both are indexed over the FULL
// signature, receiver Parameter included, which is the list the Simplifier
// emits an Argument list against.
export type ArgumentPairing = {
	forParameter: Array<number | null>
	omittedParameterIndices: Array<number>
}

// NOTE: What ONE refused Argument was refused for, for a report that has to
// name the Argument rather than only the signature it was held to. Collected
// only where a caller hands `matchArguments` somewhere to put it, which is the
// Diagnostic path alone: a match that is only asked whether it matches pays one
// comparison against `undefined` per refusal and nothing else.
//
// `argumentType` is null where the LABEL is what disagreed — matching an
// Argument reads its label before its Type, so there is no Type to report when
// the label is already wrong, and asking for one would type an Argument nothing
// else typed.
//
// `matchedParameters` is how many Parameters this candidate answered before it
// refused one, which is what "closest" is measured in: two candidates a call
// misses are ordered by how far into the signature the call got.
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
	| {
			type: "ArgumentMismatch"
			mismatchedArgumentIndices: Array<number>
			// NOTE: For Argument `i`, the Parameter it was paired with — which
			// is `i` itself for every call that omits nothing, and is not once
			// a default has been skipped. The Validator reports one Diagnostic
			// per mismatching Argument and names the Parameter it was held to,
			// so it needs both halves of the pair.
			parameterForArgument: Array<number>
	  }

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
	// NOTE: Read through the pairing rather than by Parameter index. An omitted
	// Parameter has no Argument at all, so it can neither bind nor wait — it is
	// treated exactly like a Parameter whose Argument names nothing.
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

	// NOTE: Only a Parameter that FOLLOWS one that waits has anything to gain
	// from being matched first, so an invocation whose waiting Arguments already
	// come last — every Method in the stdlib, `map`'s transform being its final
	// Parameter — is answered here, by a walk that allocates nothing.
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

// NOTE: Whether one Argument answers one Parameter — assignability, or, for a
// Record Parameter carrying a Record default, the partial reading that default
// buys: an Argument that writes SOME of the members and leaves the rest to the
// default. Two things have to hold for that, and `matchesType` answers neither
// on its own — every member written has to be one the Parameter declares and to
// fit it, which is `isPartialOf`, and every member the default does NOT fill in
// has to be written, which is what makes the merged value complete.
//
// NOTE: Asked of the SUBSTITUTED Parameter Type, unlike the assignability check
// beside it: `matchTypes` is handed the unsubstituted Type so that a Generic's
// first occurrence binds off the Argument, and by the time this is reached that
// has either happened or the Generic is still open — in which case the member
// comparisons bind it, through the very inference context they are given.
//
// NOTE: Extras are not refused here, because Record assignability is width
// subtyping and refusing them would make a partial Argument stricter than a
// whole one. `{ port = 1, extra = 2 }` fails `isPartialOf` all the same, since
// `extra` is not a member the Parameter declares.
function argumentFits(
	parameter: common.Parameter,
	expectedType: common.Type | common.GenericUse,
	argument: MatchableArgument,
	argumentType: common.Type,
	inferenceContext: GenericInferenceContext | null,
): boolean {
	// NOTE: A path key writes SOME of a member the default fills in, and the
	// merge makes the whole of it — so the Argument is measured by what it will
	// be, not by what it wrote. Asked before assignability rather than after it:
	// a Literal carrying one is never assignable as it stands, and asking twice
	// would bind a Generic off a partial member on the way past.
	//
	// NOTE: Asked only where a path key could possibly stand — a Parameter whose
	// default reaches into something, given an Argument written as a Record
	// Literal. `mergedValue` ENRICHES, and an Argument that reacts to the
	// position it stands in must not be enriched by a candidate merely probing.
	let effectiveType =
		(parameter.defaultNesting !== undefined &&
		argument.spellsItsMembers === true
			? mergedRecordType(
					expectedType,
					parameter.defaultNesting,
					argument.mergedValue?.(),
					inferenceContext,
				)
			: null) ?? argumentType

	if (
		matchTypes(parameter.type, effectiveType, inferenceContext, OUTERMOST)
	) {
		return true
	}

	return (
		parameter.defaultMembers !== undefined &&
		argument.spellsItsMembers === true &&
		expectedType.type === "Record" &&
		effectiveType.type === "Record" &&
		isPartialOf(expectedType, effectiveType, inferenceContext) &&
		missingRecordMembers(
			expectedType,
			parameter.defaultMembers,
			effectiveType,
		).length === 0
	)
}

// NOTE: The members a Record Argument had to write and did not — the ones its
// Parameter declares, the default does not fill in, and the Argument does not
// carry. The Validator reports them by name, which is why this answers a list
// rather than a boolean.
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
		// NOTE: Where to put what each refusal was ABOUT, in the order the
		// Arguments were matched in — see `ArgumentMismatchDetail`. Passed by the
		// reports that name the Argument a candidate refused, and by nothing else.
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

	for (let position = 0; position < parameters.length; position++) {
		let i = order === null ? position : order[position]
		let parameter = parameters[i]
		let argumentIndex = pairing.forParameter[i]

		// NOTE: A Parameter nobody wrote an Argument for takes its default,
		// which was checked against this Parameter's Type where it was written.
		// It binds nothing either — there is no Argument to read a Type off, so
		// a Type Parameter bound ONLY by an omitted Parameter stays unbound and
		// is reported as `uninferable-type-parameter`, which is the honest
		// answer: the writer either passes the Argument or writes the Type
		// Argument.
		if (argumentIndex === null) {
			continue
		}

		let argument = matchableArguments[argumentIndex]

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

		// NOTE: The label is compared before the Type is asked for, and the two
		// branches stay apart so that it still is: a labelless Argument standing
		// at a labelled Parameter is refused without typing anything, which is
		// what keeps an Argument nothing committed to from being enriched.
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
		// NOTE: Sorted, because a deferred callback may have been matched out
		// of turn — the Validator reports one Diagnostic per index and they
		// must still arrive in the order the Arguments were written.
		return {
			type: "ArgumentMismatch",
			mismatchedArgumentIndices: mismatchedArgumentIndices.sort(
				(left, right) => left - right,
			),
			parameterForArgument: argumentPairingInverse(pairing),
		}
	}

	return {
		type: "Match",
		omittedParameterIndices: pairing.omittedParameterIndices,
	}
}

// NOTE: Which Argument answers which Parameter, decided from LABELS and
// `hasDefault` alone and never from a Type. That is what makes it cheap enough
// to run once per Overload candidate, and it is also what keeps everything that
// has to know a call's shape before its Arguments are typed working: overload
// probing, the deferred-Argument order, and Completion offering labels into a
// call that is still half written.
//
// The walk is greedy — take the Argument when the labels agree, skip the
// Parameter when it has a default — and `indistinguishable-default-parameter`
// is what makes greedy complete: with no defaulted Parameter followed by a
// same-label one, an Argument has at most one Parameter it could be, so there
// is nothing to search and nothing to backtrack.
//
// `null` is an arity mismatch. A Program that declares no default anywhere pays
// one `some()` over the Parameter list and then answers with the identity
// pairing it always had.
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
			// NOTE: A required Parameter and an Argument whose label disagrees
			// — paired anyway, so that the loop above reports it as the label
			// mismatch it is rather than as a count nobody miscounted.
			forParameter.push(next)
			next++
		} else {
			return null
		}
	}

	// NOTE: Left-over Arguments mean the greedy walk skipped past a default
	// that a wrongly labelled Argument was meant for. Where the counts agree
	// after all, the identity pairing is what the writer wrote and reports the
	// label mismatch against the Parameter they clearly meant; where they do
	// not, the call really does pass the wrong number of Arguments.
	if (next !== matchableArguments.length) {
		return parameters.length === matchableArguments.length
			? identityPairing(parameters.length)
			: null
	}

	return { forParameter, omittedParameterIndices }
}

// NOTE: The answer for every signature that declares no default — Argument `i`
// answers Parameter `i`, nothing left out. It is asked once per Overload
// candidate of every call in the Program, so it is CACHED by arity rather than
// built: nothing ever writes into a pairing, and one shared Array per arity is
// indistinguishable from a fresh one that counts to the same number.
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

// NOTE: The pairing read the other way round — for Argument `i`, the Parameter
// it answers. Built only where something has to NAME that Parameter: a
// Diagnostic about a mismatching Argument, and Completion reading a Record
// literal against the Type it will be held to. The forward direction is what
// every call pays for, so the inverse is not built alongside it.
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
