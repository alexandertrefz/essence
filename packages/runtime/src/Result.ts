import { createString, itemText, type StringType } from "./String"
import { type AnyType, typeKeySymbol } from "./type"

// A builtin generic Choice, mostly written in Essence in `Result.es`. An
// Essence body builds a Case through `createCase`; the constructors here are
// for `Http.send`, the native that answers a Result.
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

export function createValue<Value extends AnyType>(
	item: Value,
): ValueType<Value> {
	return { [typeKeySymbol]: "Result#Value", item }
}

export function createFailure<Failure extends AnyType>(
	reason: Failure,
): FailureType<Failure> {
	return { [typeKeySymbol]: "Result#Failure", reason }
}

// Native so that a String payload is quoted. See "Builtin Choices" in
// DEVELOPMENT.md.
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
