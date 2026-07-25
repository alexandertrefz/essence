import type { common } from "../interfaces/index"

// NOTE: The bare Type tags — the handful of Types that have no declaration
// anywhere, because they ARE what a declaration bottoms out in. A standard
// library file writes `Boolean`, `String`, `Integer` in its signatures; these
// are what those names resolve to, and there is nowhere else they could come
// from: `src/stdlib/Boolean.es` declares the Boolean NAMESPACE, and writes
// `Boolean` in its own signatures.
//
// NOTE: This is the ONLY TypeScript left that describes a Type of the language.
// A Type belongs here if and only if no `type`, `choice` or `protocol`
// declaration could produce it — `Number` and `Irrational` are Unions and live
// in `src/stdlib/Number.es`, `Optional` and `Ordering` in files of their own.
// Nothing compares these by identity; a consumer that needs "is this an
// Integer?" reads the `type` tag.

export const booleanType: common.BooleanType = { type: "Boolean" }
export const stringType: common.StringType = { type: "String" }
export const integerType: common.IntegerType = { type: "Integer" }
export const rationalType: common.RationalType = { type: "Rational" }
export const algebraicType: common.AlgebraicType = { type: "Algebraic" }
export const transcendentalType: common.TranscendentalType = {
	type: "Transcendental",
}
export const nothingType: common.NothingType = { type: "Nothing" }

// NOTE: The open Record Type — `{}` members, which every Record is assignable
// to. It is the receiver Type the Record Namespace targets.
export const recordType: common.RecordType = { type: "Record", members: {} }

// NOTE: `List` names the unapplied List Type — `List<Item>` applies it. The
// default keeps a bare `List` annotation meaningful.
export const genericListType: common.GenericListType = {
	type: "GenericList",
	generics: [{ name: "ItemType", defaultType: { type: "Unknown" } }],
}

// NOTE: The Type Scope a standard library file starts from, before a single
// line of it has been read.
export const primitiveTypes: Record<string, common.Type> = {
	Boolean: booleanType,
	String: stringType,
	Integer: integerType,
	Rational: rationalType,
	Algebraic: algebraicType,
	Transcendental: transcendentalType,
	Nothing: nothingType,
	Record: recordType,
	List: genericListType,
}
