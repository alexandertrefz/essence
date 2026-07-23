import type { common } from "../interfaces/index"
import { loadStdlib } from "./stdlib"

// NOTE: The single source of truth for what exists before the first line of a
// Program. The Enricher builds its top-level Scope from these accessors, and
// the Language Server derives its builtin listings from the same ones — a new
// builtin registered here reaches resolution, completion, rename and
// semantic tokens in one step, and can not be half-wired again.
//
// NOTE: The standard library itself is written in Essence, under `src/stdlib`.
// Nothing a Program starts with is declared in TypeScript any more: `loadStdlib`
// reads those sources once per process and the accessors at the foot of this
// file hand out what it produced. What is left in this file is the ORDER those
// names are listed in — the one thing a source file can not say about itself,
// because each declares only its own name.

// NOTE: The order the builtin members are listed in. A source declaration is
// enriched INTO the Scope, so it lands where insertion put it — which is the
// order `readStdlibSources` happened to sort the file names in, and nothing an
// editor of `src/stdlib` would think to control. The order is observable:
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
	"String",
	"Boolean",
	"Integer",
	"Rational",
	"Algebraic",
	"Transcendental",
	"Number",
	"Nothing",
	"Optional",
	"Ordering",
	"Side",
	"NumberFormat",
	"Record",
	"List",
	// NOTE: Directly after `List`, because both target a List and the position
	// IS the tie-break. The Enricher builds `matchingNamespaces` in this order
	// and Completion dedupes members first-Namespace-wins, so a
	// `List<List<…>>` receiver has to meet the general `List` FIRST and pick up
	// `NestedList::flattened` as the extra it is — putting it ahead of `List`
	// would make the narrow Namespace the first one searched for every Method a
	// nested List has, and would name it first in every "searched Namespaces"
	// Diagnostic. It is listed here at all, rather than left to fall to the
	// end, so that the two Namespaces a List value can reach sit together where
	// a reader of this list expects them.
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
	"Rational",
	"Algebraic",
	"Transcendental",
	"Nothing",
	"Record",
	"List",
	"Irrational",
	"Number",
	"Optional",
	"Ordering",
	"Side",
	"NumberFormat",
]

// NOTE: Accessors rather than consts, because what they answer with is read
// from Essence source at first call. `loadStdlib` parses, enriches and
// validates `src/stdlib/*.es`, caches the result for the process, and hands
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
