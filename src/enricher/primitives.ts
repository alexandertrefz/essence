import type { common } from "../interfaces/index"

// NOTE: The bare Type tags — the handful of Types that have no declaration
// anywhere, because they ARE what a declaration bottoms out in. A standard
// library file writes `Boolean`, `String`, `Integer` in its signatures; these
// are what those names resolve to while the Namespaces around them are read
// from Essence source.
//
// NOTE: The legacy TypeScript tables in `./types/*.ts` still export their own
// `type` consts, and stay untouched until the Namespace that owns each one is
// converted. These are deliberately a second, standalone spelling rather than
// a re-export: the tables are being deleted Namespace by Namespace, and the
// primitives have to outlive all of them.

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
