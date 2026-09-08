import { createString, itemText, type StringType } from "./String"
import { type AnyType, typeKeySymbol } from "./type"

// NOTE: `Result` is a builtin generic Choice, like `Optional` — its values carry
// Case tags (`"Result#Value"`, `"Result#Failure"`) exactly as user-declared
// Cases do. Every Method of the covering Namespace but one is written in
// Essence (`packages/standard-library/sources/Result.es`); what else lives here
// is the Type the generated native contract renders that one signature against.
//
// NOTE: No constructors, where `Optional.ts` carries two. An Optional is built
// by the natives themselves — every one that can come back empty — and no
// native answers a Result: the Cases are built by Essence bodies, which the
// Rewriter emits as `$type.createCase` calls.
export type ValueType<Value extends AnyType> = {
	[typeKeySymbol]: "Result#Value"
	item: Value
}

export type FailureType<Failure extends AnyType> = {
	[typeKeySymbol]: "Result#Failure"
	reason: Failure
}

export type ResultType<Value extends AnyType, Failure extends AnyType> =
	| ValueType<Value>
	| FailureType<Failure>

// NOTE: The one Method here, and native for the reason `Optional.toString` is:
// an Essence body renders a payload through a hole, and a hole renders a String
// BARE. So the entry could not say the rule `itemText` holds — a String is
// quoted inside a structure — and `#Failure("gone")` printed as `Failure(gone)`,
// which `#Failure("")` then read as a word and a pair of parentheses.
//
// NOTE: The `#` sigil is left out, as `Optional` prints `Value` and `Ordering`
// prints `Less`. A rendering names the Case; it does not quote the Expression
// that builds it. Both Cases carry a payload, so both are written with the
// parentheses `Optional#Empty` has no use for.
export function toString<Value extends AnyType, Failure extends AnyType>(
	result: ResultType<Value, Failure>,
	valueConformance: {
		toString: (value: Value) => StringType
	},
	failureConformance: {
		toString: (value: Failure) => StringType
	},
): StringType {
	return result[typeKeySymbol] === "Result#Value"
		? createString(`Value(${itemText(result.item, valueConformance)})`)
		: createString(
				`Failure(${itemText(result.reason, failureConformance)})`,
			)
}
