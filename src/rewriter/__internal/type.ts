import type { common } from "../../interfaces/index"
import type { BooleanType } from "./Boolean"
import type { IntegerType } from "./Integer"
import type { ListType } from "./List"
import type { NothingType } from "./Nothing"
import type { OrderingType } from "./Ordering"
import type { RationalType } from "./Rational"
import type { RecordType } from "./Record"
import type { StringType } from "./String"

export const typeKeySymbol = Symbol("$type")

// NOTE: The runtime half of Union Method dispatch — each case holds a member
// Type descriptor, the statically chosen Method, and that Method's hidden
// conformance Arguments. The Enricher orders the cases most specific first
// and only emits a dispatch when some case is guaranteed to match.
export function dispatchMethod(
	receiver: AnyType,
	args: Array<unknown>,
	cases: Array<
		[common.Type, (...args: Array<unknown>) => unknown, Array<unknown>]
	>,
): unknown {
	for (let [type, method, conformanceArguments] of cases) {
		if (isValueOfType(receiver, type)) {
			return method(receiver, ...args, ...conformanceArguments)
		}
	}

	throw new Error("No dispatch case matched the receiver.")
}

// NOTE: The runtime shape of a constructed Choice Case — the payload's
// members with the Case's tag (`"CalculatorOperation#Add"`) on the hidden
// Type key. Unit Cases simply carry no further members.
export type CaseInstanceType = {
	[typeKeySymbol]: string
	[key: string]: AnyType
}

export function createCase(
	tag: string,
	payload?: Record<string, AnyType>,
): CaseInstanceType {
	return { ...payload, [typeKeySymbol]: tag }
}

// NOTE: CaseInstanceType is deliberately NOT part of AnyType — its
// `[typeKeySymbol]: string` would defeat the tag-based narrowing every
// runtime helper relies on. Case values still flow through these helpers at
// runtime; only the compile-time union stays precise.
export type AnyType =
	| RecordType
	| ListType<any>
	| StringType
	| IntegerType
	| RationalType
	| BooleanType
	| NothingType
	| OrderingType

// TODO: Handle Record Types
export function isValueOfType(value: AnyType, type: common.Type): boolean {
	if (type.type === "Nothing") {
		return value[typeKeySymbol] === "Nothing"
	} else if (type.type === "Boolean") {
		return value[typeKeySymbol] === "Boolean"
	} else if (type.type === "String") {
		return value[typeKeySymbol] === "String"
	} else if (type.type === "Integer") {
		return value[typeKeySymbol] === "Integer"
	} else if (type.type === "Rational") {
		return value[typeKeySymbol] === "Rational"
	} else if (type.type === "Record") {
		if (value[typeKeySymbol] !== "Record") {
			return false
		}

		// NOTE: Structural and open — the value has to carry every member the
		// Matcher names, matching in Type, but may carry more besides.
		return Object.entries(type.members).every(
			([name, memberType]) =>
				name in value && isValueOfType(value[name], memberType),
		)
	} else if (type.type === "Case") {
		// NOTE: Nominal — only the tag decides, the payload's structure never
		// does. A structurally identical plain Record is not this Case.
		return value[typeKeySymbol] === `${type.choice}#${type.name}`
	} else if (type.type === "UnionType") {
		return type.types.some((memberType) => isValueOfType(value, memberType))
	} else if (type.type === "GenericUse") {
		// NOTE: Types erase at runtime — a Generic matcher stands for any
		// value. Handlers are tested in order, so concrete matchers narrow
		// the value before a Generic matcher catches the rest.
		return true
	} else if (type.type === "Unknown") {
		// NOTE: The Type a wildcard Handler (`case _`) resolves to once no
		// Types are left to narrow — like a Generic matcher, it accepts
		// whatever the Handlers before it did not catch.
		return true
	} else {
		console.log("Complex type checking has yet to be implemented!")
		return false
	}
}
