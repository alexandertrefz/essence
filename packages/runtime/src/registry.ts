import type { RationalType } from "./Rational"
import type { AnyType } from "./type"

// NOTE: THE KIND REGISTRY — where a runtime module that owns a container says
// how a value of it is RENDERED and how two of them are COMPARED, so that the
// three walks which meet every kind of value — the printer in `Terminal.ts`,
// the universal equality in `internalHelpers.ts` and the structural difference
// in `Testing.ts` — need no arm of their own for it.
//
// NOTE: The point is what a Program that never names the container pays, which
// is nothing. Each of those three walks probes this table on its FALLTHROUGH
// only, so the builtin kinds are answered by the arms they always were, and the
// arms a container needs ride in with the container's own module rather than
// with the walk. `Dictionary`'s cost the printer 1,281 bytes of every Program
// that printed anything at all, Dictionary or not.
//
// NOTE: This module imports NOTHING at run time — the two imports above are
// erased with the types they name — which is what lets a container's module
// register into it without either of the three walks having to import that
// container back.
const kinds = new Map<string, RegisteredKind>()

// NOTE: The width a single-line rendering is allowed before it is broken over
// lines. It lives here rather than in `Terminal.ts` because a registered
// renderer lays its own value out and has to break at the width the walk around
// it breaks at, and a second copy of the number would be two rules.
export const singleLineMaxLength = 60

// NOTE: The TEXT a STRUCTURAL rendering gives a Case — the Choice and the Case
// and nothing in front of them. It lives beside the width above for the same
// reason: each of the three walks named at the top of this file meets a Case,
// and a second copy of the rule would be two answers to one question.
//
// NOTE: The tag itself keeps its Module. A Choice is identified by the file
// that declares it as well as by its name — which is what keeps one Module's
// `Door` from being another's at run time — so a tag reads
// `"./Doors.es#Door#Open"`. But a Module path is where that file happened to
// sit on the machine that COMPILED the Program: printing it put a build
// machine's path in the output, made renaming a file change what a Program
// said, and broke every snapshot holding such a value. Only the text changes
// here; the tag a value is stamped with is untouched.
//
// NOTE: The last TWO segments, found from the END. Neither a Choice name nor a
// Case name can hold a `#`, so the two separators nearest the end are the right
// ones however many a Module path holds. A standard library Choice carries no
// Module and its tag is already this form — `Ordering#Less` comes back
// untouched — and a tag with no `#` at all is no Case, so it does too. Two
// Modules that both declare a `Door` therefore both print `Door#Open`: the
// values stay distinct, only their rendering collides.
//
// NOTE: A tag carrying ONE `#` needs no cell of its own, and the arithmetic
// rather than a second guard is what says so: `lastIndexOf` answers -1 for the
// separator that is not there, and slicing from 0 is the whole tag. A guard for
// it stood here until mutation testing found that no mutant of it could go red
// — there is no tag it would answer differently about.
//
// NOTE: The guard that is LEFT is a reader's, not the arithmetic's. A tag with
// no `#` at all comes out whole either way, because JavaScript clamps a
// negative `fromIndex` to 0 and the search then fails — so breaking this guard
// is an equivalent mutant too. It stays because `Integer` is not a Case and the
// line should say so, rather than leaving a reader to work out that two
// separate clamping rules happen to meet on the right answer.
export function caseText(tag: string): string {
	let separator = tag.lastIndexOf("#")

	return separator === -1
		? tag
		: tag.slice(tag.lastIndexOf("#", separator - 1) + 1)
}

// NOTE: How the printer renders a value it does not know: the same four
// arguments `getStringRepresentation` carries, handed back so a registered
// renderer can render what its value HOLDS through the one walk rather than
// through a second reading of it.
export type RenderPart = (
	value: AnyType,
	indentLevel: number,
	rationalForm: (rational: RationalType) => string,
	listPadding: string,
) => string

export type RegisteredKind = {
	// NOTE: What the difference in `Testing.ts` brackets the kind's parts with,
	// which for a container is what a Program writes one down in.
	open: string
	close: string
	render: (
		value: AnyType,
		indentLevel: number,
		rationalForm: (rational: RationalType) => string,
		listPadding: string,
		renderPart: RenderPart,
	) => string
	// NOTE: The kind's parts, each under the name a reader reads it by — the
	// shape the difference pairs two values up by. A part's name is a rendering
	// as well, so the renderer the difference uses is handed in.
	parts: (
		value: AnyType,
		render: (value: AnyType) => string,
	) => Array<[string, AnyType]>
	// NOTE: The UNIVERSAL comparison — two values of the kind compared where
	// there is no conformance witness in hand, with `same` the same universal
	// comparison for whatever they hold. A container may answer this one
	// through an index of its own, since `same` is the structural equality its
	// keys are already organised by.
	equals: (
		first: AnyType,
		second: AnyType,
		same: (first: AnyType, second: AnyType) => boolean,
	) => boolean
	// NOTE: And the DESCRIPTOR-driven one, where each half of what the value
	// holds is compared by a rule of its own — a witness the Compiler named, or
	// another descriptor. Nothing the caller hands in is the kind's own
	// equality, so nothing here may be shortcut by an index.
	equalsBy: (
		first: AnyType,
		second: AnyType,
		sameKey: (first: AnyType, second: AnyType) => boolean,
		sameValue: (first: AnyType, second: AnyType) => boolean,
	) => boolean
}

// NOTE: Called by the owning module, not by the walks. A kind is registered
// once, under the tag its values carry, and registering twice is registering
// the same module twice — the second is the first.
export function registerKind(tag: string, kind: RegisteredKind): void {
	kinds.set(tag, kind)
}

// NOTE: What answers for a tag, or `undefined` where nothing does — which is
// every tag in a Program that never loaded the module that would have
// registered one, and is why each caller keeps the answer it had for an
// unrecognised value.
export function kindOf(tag: string): RegisteredKind | undefined {
	return kinds.get(tag)
}
