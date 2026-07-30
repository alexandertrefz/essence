import type { common } from "@essence-lang/interfaces"

import { loadStdlib } from "./stdlib"

// NOTE: The single source of truth for what exists before the first line of a
// Program. The Enricher builds its top-level Scope from these accessors, and
// the Language Server derives its builtin listings from the same ones — a new
// builtin registered here reaches resolution, completion, rename and
// semantic tokens in one step, and can not be half-wired again.
//
// NOTE: The standard library itself is written in Essence, under `packages/stdlib/sources`.
// Nothing a Program starts with is declared in TypeScript any more: `loadStdlib`
// reads those sources once per process and the accessors at the foot of this
// file hand out what it produced. What is left in this file is the ORDER those
// names are listed in — the one thing a source file can not say about itself,
// because each declares only its own name.

// NOTE: The order the builtin members are listed in. A source declaration is
// enriched INTO the Scope, so it lands where insertion put it — which is the
// order `readStdlibSources` happened to sort the file names in, and nothing an
// editor of `packages/stdlib/sources` would think to control. The order is observable:
// `builtinNamespaces()` derives from it, Completion dedupes members
// first-Namespace-wins (`lsp/completion.ts`), and the Enricher builds its
// `matchingNamespaces` in the same order — so it is stated here, once, rather
// than left to the file system.
//
// NOTE: This is the order BETWEEN Namespaces. The order WITHIN one — its
// Methods and Properties — is a property of the declaration itself, and is
// simply the order the `.es` file writes them in.
//
// A name missing from this list is appended in the order it was declared, so
// a genuinely new builtin costs nothing until it needs a place of its own.
export const builtinMemberOrder: Array<string> = [
	"__print",
	"loop",
	"String",
	"Boolean",
	"Integer",
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
	"Case",
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
	"Integer",
	// NOTE: Directly after the Type it refines, for the reason `NestedList` sits
	// directly after `List` — a reader of this table meets `Integer` and then what
	// an Integer can be proven to be, and `closestMatch` breaks a tie on the FIRST
	// candidate, so a typo near both still reads as the base Type.
	"NonZeroInteger",
	"Rational",
	"Algebraic",
	"Transcendental",
	"Record",
	"List",
	"Irrational",
	"Number",
	"Optional",
	"Ordering",
	"Side",
	"Case",
	"Step",
	"NormalizationForm",
	"NumberFormat",
	"Rounding",
]

// NOTE: The third table's order, stated for the same reason as the two above.
// It is read in order wherever the builtin Protocols are LISTED rather than
// looked up — Hover and Completion both build their list by spreading this, and
// `rename` walks it — so leaving it to fall out of whatever order the sources
// were merged in makes an editor's list reorder itself for reasons no one
// editing `packages/stdlib/sources` would think to control. It is the order they
// are declared in, which is also the order they build on each other: `Comparable`
// is the only one whose signature names a Type rather than only bare tags.
export const builtinProtocolOrder: Array<string> = [
	"Equatable",
	"Printable",
	"Comparable",
]

// NOTE: Accessors rather than consts, because what they answer with is read
// from Essence source at first call. `loadStdlib` parses, enriches and
// validates `packages/stdlib/sources/*.es`, caches the result for the process, and hands
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
