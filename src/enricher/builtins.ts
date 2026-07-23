import type { common } from "../interfaces/index"
import { loadStdlib } from "./stdlib"
// NOTE: The Algebraic NAMESPACE now lives in `src/stdlib/Algebraic.es`. Its
// Type tag stays for the same reason Boolean's does — a bare primitive tag with
// no declaration to write.
import { type as algebraicType } from "./types/Algebraic"
// NOTE: The Boolean NAMESPACE now lives in `src/stdlib/Boolean.es` and is
// gone from the table below. Its Type tag stays — a `type` is subtracted from
// the legacy tables only by a source `type` declaration, and Boolean's is a
// bare primitive tag with no declaration to write.
import { type as booleanType } from "./types/Boolean"
// NOTE: The Integer NAMESPACE now lives in `src/stdlib/Integer.es`. Its Type
// tag stays for the same reason Boolean's does — a bare primitive tag with no
// declaration to write.
import { type as integerType } from "./types/Integer"
// NOTE: The List NAMESPACE now lives in `src/stdlib/List.es` — the last table
// to move. Its Type tag stays for the same reason Boolean's does: `GenericList`
// is a bare tag with an `ItemType` Parameter and no declaration to write.
import { type as listType } from "./types/List"
import nativeFunctions from "./types/NativeFunctions"
// NOTE: The Nothing NAMESPACE now lives in `src/stdlib/Nothing.es`. Its Type
// tag stays for the same reason Boolean's does.
import { type as nothingType } from "./types/Nothing"
// NOTE: The Number NAMESPACE and BOTH Union Types it brought with it —
// `Number` itself and the `Irrational` alias, which used to be assembled inline
// right here — now live in `src/stdlib/Number.es`. A Type and the Namespace
// that targets it move together, so `types/Number.ts` is imported nowhere any
// more; it stays on disk only for `stdlibEquivalence.spec.ts` to compare
// against.
// NOTE: `Optional` and `Ordering` moved WHOLE — the Type and the Namespace
// that targets it in one step, as the subtraction in `stdlib.ts` requires.
// `src/stdlib/Optional.es` declares `type Optional<ItemType>` and
// `src/stdlib/Ordering.es` the `choice Ordering`, so neither name is left here
// on either side.
// NOTE: The three core Protocols are declared in `src/stdlib/Protocols.es`.
// `types/Protocols.ts` is now imported by nothing in production — the List
// table was the last consumer of its `conformedMethods` helper, and
// `src/stdlib/List.es` writes `is`/`isNot`/`toString` out explicitly with the
// same documentation, with `checkProtocolConformance` guarding the drift the
// derivation used to make impossible. Only `stdlibEquivalence.spec.ts` still
// reads it, and it goes with the tables.
// NOTE: The Rational NAMESPACE now lives in `src/stdlib/Rational.es`. Its Type
// tag stays for the same reason Integer's does.
import { type as rationalType } from "./types/Rational"
// NOTE: The Record NAMESPACE now lives in `src/stdlib/Record.es`. Its Type is
// the open Record `{}`, which has no declaration to write either.
import { type as recordType } from "./types/Record"
// NOTE: The String NAMESPACE now lives in `src/stdlib/String.es`. Its Type tag
// stays for the same reason Boolean's does — a bare primitive tag with no
// declaration to write.
import { type as stringType } from "./types/String"
// NOTE: The Transcendental NAMESPACE now lives in
// `src/stdlib/Transcendental.es`. Its Type tag stays for the same reason
// Algebraic's does.
import { type as transcendentalType } from "./types/Transcendental"

// NOTE: The single source of truth for what exists before the first line of a
// Program. The Enricher builds its top-level Scope from these accessors, and
// the Language Server derives its builtin listings from the same ones — a new
// builtin registered here reaches resolution, completion, rename and
// semantic tokens in one step, and can not be half-wired again.
// NOTE: The standard library is being moved out of TypeScript and into Essence
// source under `src/stdlib`. Until it has all moved, what a Program starts with
// is the union of both halves — which is what `loadStdlib` assembles, and what
// the accessors at the foot of this file hand out.

// NOTE: The hand written TypeScript half of the standard library. Every name
// here is still declared in TypeScript rather than in Essence; as each
// Namespace is converted the entry is deleted from this table and the `.es`
// file that replaces it takes over the name. The loader subtracts whatever the
// sources declare from these before they seed anything, so the two halves can
// never both claim a name.
// NOTE: Down to `__print` — every Namespace has moved. What is left is not a
// legacy table at all any more but `NativeFunctions`, the one member with no
// Namespace to live in; the name and the subtraction machinery stay only until
// the tables themselves are deleted.
export const legacyMembers: Record<string, common.Type> = {
	...nativeFunctions,
}

// NOTE: The order the builtin members are listed in, INDEPENDENT of which half
// of the standard library declares them. Without it the merged table lists the
// legacy names first and the source-declared ones after, so converting a
// Namespace would silently move it to the end — and the order is observable:
// `builtinNamespaces()` derives from it, Completion dedupes members
// first-Namespace-wins (`lsp/completion.ts`), and the Enricher builds its
// `matchingNamespaces` in the same order. A conversion must not change what an
// Editor offers first.
//
// NOTE: This is the order BETWEEN Namespaces. The order WITHIN one — its
// Methods and Properties — is a property of the declaration itself, and is
// what `stdlibEquivalence.spec.ts` compares as `methodOrder`/`propertyOrder`.
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
// position must be a property of its name, not of which half declares it.
// Two surfaces read this order and would otherwise shift under a conversion:
// `closestMatch` breaks a tie on the FIRST candidate, so "did you mean …?"
// would start naming a different Type (`Oational` is distance 1 from both
// `Rational` and `Optional`), and Completion of a Type annotation ships these
// in table order with no `sortText` of its own.
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
]

export const legacyTypes: Record<string, common.Type> = {
	Nothing: nothingType,
	Boolean: booleanType,
	String: stringType,
	Integer: integerType,
	Rational: rationalType,
	Algebraic: algebraicType,
	Transcendental: transcendentalType,
	Record: recordType,
	List: listType,
}

// NOTE: Empty — `Equatable`, `Printable` and `Comparable` are declared in
// `src/stdlib/Protocols.es` now, and every conformance clause in the tables
// still here resolves against those. The table remains so the shrinking half
// of the standard library keeps one shape until the last name has moved.
export const legacyProtocols: Record<string, common.ProtocolType> = {}

// NOTE: Accessors rather than consts, because half of what they answer with is
// read from Essence source at first call. `loadStdlib` merges the tables above
// (minus every name the source declares) with what the source declared, caches
// the result for the process, and hands back the SAME object every time — so
// these stay as cheap as the consts they replaced after the first call.
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
