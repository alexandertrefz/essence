import type { common } from "../interfaces/index"
import { loadStdlib } from "./stdlib"
import {
	namespace as algebraicNamespace,
	type as algebraicType,
} from "./types/Algebraic"
// NOTE: The Boolean NAMESPACE now lives in `src/stdlib/Boolean.es` and is
// gone from the table below. Its Type tag stays — a `type` is subtracted from
// the legacy tables only by a source `type` declaration, and Boolean's is a
// bare primitive tag with no declaration to write.
import { type as booleanType } from "./types/Boolean"
// NOTE: The Integer NAMESPACE now lives in `src/stdlib/Integer.es`. Its Type
// tag stays for the same reason Boolean's does — a bare primitive tag with no
// declaration to write.
import { type as integerType } from "./types/Integer"
import { namespace as listNamespace, type as listType } from "./types/List"
import nativeFunctions from "./types/NativeFunctions"
// NOTE: The Nothing NAMESPACE now lives in `src/stdlib/Nothing.es`. Its Type
// tag stays for the same reason Boolean's does.
import { type as nothingType } from "./types/Nothing"
import {
	namespace as numberNamespace,
	type as numberType,
} from "./types/Number"
// NOTE: `Optional` and `Ordering` moved WHOLE — the Type and the Namespace
// that targets it in one step, as the subtraction in `stdlib.ts` requires.
// `src/stdlib/Optional.es` declares `type Optional<ItemType>` and
// `src/stdlib/Ordering.es` the `choice Ordering`, so neither name is left here
// on either side.
// NOTE: The three core Protocols are declared in `src/stdlib/Protocols.es`.
// `types/Protocols.ts` stays plugged in nowhere but keeps its
// `conformedMethods` helper, which the List table still derives its conformed
// Methods with — the Protocol objects it reads are structurally the ones the
// source declares.
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
import {
	namespace as transcendentalNamespace,
	type as transcendentalType,
} from "./types/Transcendental"

// NOTE: The single source of truth for what exists before the first line of a
// Program. The Enricher builds its top-level Scope from these accessors, and
// the Language Server derives its builtin listings from the same ones — a new
// builtin registered here reaches resolution, completion, rename and
// semantic tokens in one step, and can not be half-wired again.
// NOTE: The standard library is being moved out of TypeScript and into Essence
// source under `src/stdlib`. Until it has all moved, what a Program starts with
// is the union of both halves — which is what `loadStdlib` assembles, and what
// the accessors at the foot of this file hand out.

// NOTE: `Irrational` is a transparent alias for `Algebraic | Transcendental`
// — the pair are definitional complements (transcendental means "not
// algebraic"), so the alias covers exactly the representable irrationals and
// makes `π is Irrational` a true sentence.
const irrationalType: common.UnionType = {
	type: "UnionType",
	name: "Irrational",
	types: [algebraicType, transcendentalType],
}

// NOTE: The hand written TypeScript half of the standard library. Every name
// here is still declared in TypeScript rather than in Essence; as each
// Namespace is converted the entry is deleted from this table and the `.es`
// file that replaces it takes over the name. The loader subtracts whatever the
// sources declare from these before they seed anything, so the two halves can
// never both claim a name.
export const legacyMembers: Record<string, common.Type> = {
	...nativeFunctions,
	Algebraic: algebraicNamespace,
	Transcendental: transcendentalNamespace,
	Number: numberNamespace,
	List: listNamespace,
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
	Irrational: irrationalType,
	Record: recordType,
	Number: numberType,
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
