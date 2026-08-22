import type { common } from "@essence-lang/interfaces"

import { loadStdlib } from "./stdlib"

// NOTE: The single source of truth for what exists before the first line of a
// Program. The Enricher builds its top-level Scope from these accessors, and
// the Language Server derives its builtin listings from the same ones — a new
// builtin registered here reaches resolution, completion, rename and
// semantic tokens in one step, and can not be half-wired again.
//
// NOTE: The standard library itself is written in Essence, under `packages/standard-library/sources`.
// Nothing a Program starts with is declared in TypeScript any more: `loadStdlib`
// reads those sources once per process and the accessors at the foot of this
// file hand out what it produced. What is left in this file is the ORDER those
// names are listed in — the one thing a source file can not say about itself,
// because each declares only its own name.

// NOTE: The order the builtin members are listed in. A source declaration is
// enriched INTO the Scope, so it lands where insertion put it — which is the
// order `readStdlibSources` happened to sort the file names in, and nothing an
// editor of `packages/standard-library/sources` would think to control. The order is observable:
// `builtinNamespaces()` derives from it, Completion dedupes members
// first-Namespace-wins (`lsp/completion.ts`), and the Enricher builds its
// `matchingNamespaces` in the same order — so it is stated here, once, rather
// than left to the file system.
//
// NOTE: This is the order BETWEEN Namespaces. The order WITHIN one — its
// Methods and Properties — is a property of the declaration itself, and is
// simply the order the `.es` file writes them in. Which is not left to
// whoever wrote it either: `packages/standard-library/DEVELOPMENT.md`, Member
// order, states the six groups every Namespace declares its members in, and
// `packages/compiler/src/tests/stdlibMemberOrder.spec.ts` holds the sources to
// them.
//
// A name missing from this list is appended in the order it was declared, so
// a genuinely new builtin costs nothing until it needs a place of its own.
export const builtinMemberOrder: Array<string> = [
	"Terminal",
	"loop",
	"String",
	"Boolean",
	"Integer",
	// NOTE: Directly after `Integer`, for the reason `NestedList` sits directly
	// after `List` — the two Namespaces one Integer value can reach belong
	// together, and the general one has to be met FIRST so that
	// `NonZeroInteger::multiply` reads as the extra a proven Integer has.
	"NonZeroInteger",
	// NOTE: And the second refinement of `Integer` after the first, for the same
	// reason. The two share no Method name, so their order decides nothing
	// between them — they are listed together so that a reader meets what an
	// Integer can be proven to be in one place.
	"NonNegativeInteger",
	"Rational",
	"Algebraic",
	"Transcendental",
	"Number",
	"Optional",
	// NOTE: Directly after `Optional`, for the reason `NestedList` sits
	// directly after `List` — the two Namespaces one Optional value can reach
	// belong together, and the general one has to be met FIRST so that
	// `NestedOptional::flatten` reads as the extra a nested Optional has.
	"NestedOptional",
	"Ordering",
	"Side",
	"CaseSensitivity",
	"NormalizationForm",
	"NumberFormat",
	"Rounding",
	"Record",
	"List",
	// NOTE: Directly after `List`, because both target a List and the position
	// decides how the two are PRESENTED. The Enricher builds
	// `matchingNamespaces` in this order and Completion dedupes members
	// first-Namespace-wins, so a `List<List<…>>` receiver has to meet the
	// general `List` FIRST and pick up `NestedList::flattened` as the extra it
	// is — putting it ahead of `List` would make the narrow Namespace the first
	// one searched for every Method a nested List has, and would name it first
	// in every "searched Namespaces" Diagnostic. It is listed here at all,
	// rather than left to fall to the end, so that the two Namespaces a List
	// value can reach sit together where a reader of this list expects them.
	// What a call RESOLVES to is not decided here: two Namespaces declaring one
	// Method name are separated by target specificity, where the nested target
	// beats the flat one regardless of this order.
	"NestedList",
	// NOTE: And after both, for the third time and the same reason. `NonEmptyList`
	// targets a refinement of `List`, and its `firstItem`/`lastItem` are named by
	// `List` as well — so `List` has to be met FIRST, or Completion on any List
	// would offer the total pair that only a proven List can answer. Which
	// Namespace a call RESOLVES to is not decided here either: the refined target
	// beats the base one regardless of this order.
	"NonEmptyList",
	// NOTE: And after both of the Namespaces it narrows, for the same reason a
	// fourth time. `NonEmptyNestedList` targets a proven List of proven Lists,
	// which is a `List<List<…>>` and a `NonEmptyList` as well, so a receiver of
	// that Type reaches `NestedList::flatten` and `NonEmptyList::firstItem`
	// too. Both have to be met FIRST, or Completion on a nested List would
	// offer the total `flatten` that only two proofs can answer.
	"NonEmptyNestedList",
	// NOTE: And after all four, for the same reason a fifth time. Each of
	// these targets a List of a particular Number Type — `List<Integer>`,
	// `List<Rational>`, the mixed `List<Integer | Rational>` and the proven
	// forms of the three — so `List` has to be met FIRST, and each general one
	// before the proven one it narrows.
	"IntegerList",
	"RationalList",
	"NumberList",
	"NonEmptyIntegerList",
	"NonEmptyRationalList",
	"NonEmptyNumberList",
	// NOTE: Last of the List Namespaces, though its target is the widest of
	// them all. It narrows nothing and nothing narrows it — what makes a List
	// reach it is the KEY its two aggregates take, not the items — so the order
	// is free, and met last it reads as the extra it is: a List's own members
	// are `List`'s, and these come after them.
	"KeyedNumberList",
	// NOTE: And after it, for the reason every proven Namespace sits after the
	// one it narrows — a reader meets a List's own keyed aggregates before the
	// extra a proof adds. Both declare `average`, and neither what Completion
	// SHOWS nor what a call RESOLVES to turns on the order: the name is claimed
	// by whichever of the two is met first, `mostSpecificMethod` then shows the
	// refined entry's signature either way, and the Enricher picks the refined
	// target for the same reason. All this order decides is where the one
	// `average` lands in the list.
	"NonEmptyKeyedNumberList",
	// NOTE: Last, and not because it is newest. `Randomness` targets a Type
	// nothing else targets and shares not one Method name with the Namespaces
	// above it, so its position decides nothing at all — and a reader of this
	// list meets the Namespaces of the values a Program works with before the
	// one only a property test is handed.
	"Randomness",
]

// NOTE: The same rule for the Type table, and for the same reason — a Type's
// position must be a property of its name, not of the file name that happens to
// declare it. Two surfaces read this order: `closestMatch` breaks a tie on the
// FIRST candidate, so "did you mean …?" would otherwise name whichever Type
// sorted first (`Oational` is distance 1 from both `Rational` and `Optional`),
// and Completion of a Type annotation ships these in table order with no
// `sortText` of its own.
export const builtinTypeOrder: Array<string> = [
	"Boolean",
	"String",
	// NOTE: Directly after the Type it refines, for the reason `NonZeroInteger`
	// sits directly after `Integer`.
	"NonEmptyString",
	"Integer",
	// NOTE: Directly after the Type it refines, for the reason `NestedList` sits
	// directly after `List` — a reader of this table meets `Integer` and then what
	// an Integer can be proven to be, and `closestMatch` breaks a tie on the FIRST
	// candidate, so a typo near both still reads as the base Type.
	"NonZeroInteger",
	// NOTE: The other two refinements of `Integer`, with the first and in the
	// order they build on each other — `PositiveInteger` is spelled as the
	// conjunction of the two above it, so a value of it is both.
	"NonNegativeInteger",
	"PositiveInteger",
	"Rational",
	"Algebraic",
	"Transcendental",
	"Record",
	"List",
	// NOTE: Directly after the Type it refines, for the reason `NonZeroInteger`
	// sits directly after `Integer` — a reader of this table meets `List` and
	// then what a List can be proven to be, and `closestMatch` breaks a tie on
	// the FIRST candidate, so a typo near both still reads as the base Type.
	"NonEmptyList",
	"Irrational",
	"Number",
	"Optional",
	"Ordering",
	"Side",
	"CaseSensitivity",
	"Step",
	"NormalizationForm",
	"NumberFormat",
	"Rounding",
	// NOTE: With the other mode Choices, and last among them because it is the
	// newest — `Stream` is the only one of them with no Namespace of its own, so
	// it appears in this table and not in the member order above.
	"Stream",
	// NOTE: After every Type a Program writes down, because it is the one Type
	// a Program never writes down: a source arrives as a Parameter of
	// `Generatable::generate` and goes nowhere else. Listing it earlier would
	// put it in front of Types in every Completion of an annotation.
	"Randomness",
]

// NOTE: The third table's order, stated for the same reason as the two above.
// It is read in order wherever the builtin Protocols are LISTED rather than
// looked up — Hover and Completion both build their list by spreading this, and
// `rename` walks it — so leaving it to fall out of whatever order the sources
// were merged in makes an editor's list reorder itself for reasons no one
// editing `packages/standard-library/sources` would think to control. It is the order they
// are declared in, which is also the order they build on each other: `Comparable`
// is the first whose signature names a Type rather than only bare tags, and
// `Orderable` extends it.
//
// NOTE: It is the order a receiver's PROVIDED Methods are offered in as well —
// they belong to no Namespace, so a listing appends them per Protocol, and this
// is that per-Protocol order.
export const builtinProtocolOrder: Array<string> = [
	"Equatable",
	"Printable",
	"Comparable",
	"Orderable",
	// NOTE: Last, because it builds on nothing above it and nothing builds on
	// it — a conformance is what a property test reads instead of deriving a
	// generator, and no other Protocol asks about one.
	"Generatable",
]

// NOTE: Accessors rather than consts, because what they answer with is read
// from Essence source at first call. `loadStdlib` parses, enriches and
// validates `packages/standard-library/sources/*.es`, caches the result for the process, and hands
// back the SAME object every time — so these stay as cheap as the consts they
// replaced after the first call.
export function builtinMembers(): Record<string, common.Type> {
	return loadStdlib().members
}

export function builtinTypes(): Record<string, common.Type> {
	return loadStdlib().types
}

export function builtinProtocols(): Record<string, common.ProtocolType> {
	return loadStdlib().protocols
}

export function builtinNamespaces(): Array<common.NamespaceType> {
	return loadStdlib().namespaces
}
