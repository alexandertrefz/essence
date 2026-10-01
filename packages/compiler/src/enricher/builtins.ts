import type { common } from "@essence-lang/interfaces"

import { loadStdlib } from "./stdlib"

// What exists before the first line of a Program. The enricher's top-level
// Scope and the language server's builtin listings both read these accessors.
// The standard library declares the names; this file states their order.

// The order of the builtin members. See "Builtin order" in DEVELOPMENT.md.
// The members within one Namespace keep their written order. See "Member
// order" in packages/standard-library/DEVELOPMENT.md.
export const builtinMemberOrder: Array<string> = [
	"Terminal",
	"loop",
	"String",
	"NonEmptyString",
	"Boolean",
	"Integer",
	"NonZeroInteger",
	"NonNegativeInteger",
	// It narrows both refinements before it, so it comes after them.
	"PositiveInteger",
	"Rational",
	"NonZeroRational",
	// The refinements of `Rational`, ordered as the Integer ones are.
	"NonNegativeRational",
	"PositiveRational",
	// After both kinds it covers, so Completion offers a one-kind receiver's
	// `add` and `multiply` from that kind's own Namespace.
	"Scalar",
	"Algebraic",
	"Transcendental",
	"Number",
	"Optional",
	"NestedOptional",
	// It shares Method names with `Optional`, but no value reaches both.
	"Result",
	"NestedResult",
	"Ordering",
	// Choices whose Methods are all derived, so they share no Method name
	// with any Namespace here.
	"Side",
	"CaseSensitivity",
	"NormalizationForm",
	"NumberFormat",
	"Rounding",
	"SignStyle",
	"Division",
	"SortOrder",
	"Stream",
	"HttpMethod",
	"Redirects",
	"Record",
	"List",
	// The Namespaces narrowing `List` by its items or by a proof, each after
	// the ones it narrows.
	"NestedList",
	"OptionalList",
	"ResultList",
	"NonEmptyList",
	"NonEmptyNestedList",
	"IntegerList",
	"RationalList",
	"NumberList",
	"NonEmptyIntegerList",
	"NonEmptyRationalList",
	"NonEmptyNumberList",
	// It targets every List and adds aggregates that take a key, so it
	// follows the List Namespaces as an extra.
	"KeyedNumberList",
	"NonEmptyKeyedNumberList",
	// No value reaches it and a Namespace before it. So it harmlessly shares
	// `of`, `is`, `toString`, `isEmpty`, `length`, `map`, `remove`,
	// `removeEvery`, `count`, `sort`, `value`, `hasValue`, `values` and `keys`.
	// `builtins.spec.ts` holds this list.
	"Dictionary",
	"NonEmptyDictionary",
	// Both target a List but are declared in `Dictionary.es`, and share no
	// Method name with any Namespace before them.
	"GroupedList",
	"GroupedNonEmptyList",
	"Randomness",
	// The Namespaces of asynchronous work, each narrower one after the one it
	// narrows.
	"Future",
	"ResultFuture",
	"FutureList",
	"NonEmptyFutureList",
	"ResultFutureList",
	"Started",
	"Async",
	"Http",
	"Response",
	// Its `toString` is written rather than derived, so it is not with the
	// other Choices.
	"HttpFailure",
]

// The order of the builtin Types. Each refinement follows the Type it
// refines, so `closestMatch` breaks a tie for the base Type. The opening
// letter comes first: `Oational` is answered `Optional` before `Rational`
// wherever they stand. See "Builtin order" in DEVELOPMENT.md.
export const builtinTypeOrder: Array<string> = [
	"Boolean",
	"String",
	"NonEmptyString",
	"Character",
	"Integer",
	"NonZeroInteger",
	"NonNegativeInteger",
	"PositiveInteger",
	"Rational",
	"NonZeroRational",
	"NonNegativeRational",
	"PositiveRational",
	"Algebraic",
	"Transcendental",
	"Record",
	"List",
	"NonEmptyList",
	"Dictionary",
	"NonEmptyDictionary",
	"Scalar",
	"Irrational",
	"Number",
	"Optional",
	"Result",
	"Ordering",
	"Side",
	"CaseSensitivity",
	"Step",
	"NormalizationForm",
	"NumberFormat",
	"Rounding",
	"SignStyle",
	"Division",
	"SortOrder",
	"Stream",
	"HttpMethod",
	"Redirects",
	"Request",
	"Response",
	"HttpFailure",
	// `Randomness`, `Future` and `Started` follow the Types a value is made of.
	"Randomness",
	"Future",
	"Started",
]

// The order of the builtin Protocols. See "Builtin order" in DEVELOPMENT.md.
export const builtinProtocolOrder: Array<string> = [
	"Equatable",
	"Printable",
	"Comparable",
	"Orderable",
	// Its requirement is a static, so it follows the four a value answers.
	"Enumerable",
	"Generatable",
]

// Accessors, because `loadStdlib` reads the tables from Essence source on
// first use and hands back the same object after that.
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
