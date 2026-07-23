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
import {
	namespace as integerNamespace,
	type as integerType,
} from "./types/Integer"
import { namespace as listNamespace, type as listType } from "./types/List"
import nativeFunctions from "./types/NativeFunctions"
import {
	namespace as nothingNamespace,
	type as nothingType,
} from "./types/Nothing"
import {
	namespace as numberNamespace,
	type as numberType,
} from "./types/Number"
import {
	namespace as optionalNamespace,
	type as optionalType,
} from "./types/Optional"
import {
	namespace as orderingNamespace,
	type as orderingType,
} from "./types/Ordering"
import { Comparable, Equatable, Printable } from "./types/Protocols"
import {
	namespace as rationalNamespace,
	type as rationalType,
} from "./types/Rational"
import {
	namespace as recordNamespace,
	type as recordType,
} from "./types/Record"
import {
	namespace as stringNamespace,
	type as stringType,
} from "./types/String"
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
	String: stringNamespace,
	Integer: integerNamespace,
	Rational: rationalNamespace,
	Algebraic: algebraicNamespace,
	Transcendental: transcendentalNamespace,
	Number: numberNamespace,
	Nothing: nothingNamespace,
	Optional: optionalNamespace,
	Ordering: orderingNamespace,
	Record: recordNamespace,
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
	Optional: optionalType,
	Ordering: orderingType,
}

export const legacyProtocols: Record<string, common.ProtocolType> = {
	Equatable,
	Printable,
	Comparable,
}

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
