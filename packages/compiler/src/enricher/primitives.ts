import type { common } from "@essence-lang/interfaces"

// The Types that have no declaration, because declarations bottom out in them.
// A Type belongs here only if no `type`, `choice` or `protocol` declaration
// could produce it; `Number` is a Union in the standard library's `Number.es`.
// Nothing compares these by identity: a consumer reads the `type` tag.

export const booleanType: common.BooleanType = { type: "Boolean" }
export const stringType: common.StringType = { type: "String" }
export const integerType: common.IntegerType = { type: "Integer" }
const rationalType: common.RationalType = { type: "Rational" }
const algebraicType: common.AlgebraicType = { type: "Algebraic" }
const transcendentalType: common.TranscendentalType = {
	type: "Transcendental",
}
// The source a property test generates its values from. Its state is
// readable only by the runtime.
const randomnessType: common.RandomnessType = { type: "Randomness" }
// A `Future` describes work that answers with its `valueType`, and a `Started`
// is one run of it in flight. The name resolves to the applied shape with an
// Unknown slot, which `Future<Integer>` fills. A bare `Future` is refused by
// `resolveIdentifierTypeDeclarationType`, so the slot never stays open.
const futureType: common.FutureType = {
	type: "Future",
	valueType: { type: "Unknown" },
}
const startedType: common.StartedType = {
	type: "Started",
	valueType: { type: "Unknown" },
}

// The open Record Type, with no members, which every Record is assignable to.
// The Record Namespace targets it, and it is the unit Type a Function answering
// nothing useful promises. See `isUnitType`.
export const recordType: common.RecordType = { type: "Record", members: {} }

// `List` names the unapplied List Type, which `List<Item>` applies. The
// default keeps a bare `List` annotation meaningful.
const genericListType: common.GenericListType = {
	type: "GenericList",
	generics: [{ name: "ItemType", defaultType: { type: "Unknown" } }],
}

// The same for `Dictionary`, which `Dictionary<Key, Value>` applies. A bare
// `Dictionary` has decided neither slot, and each is decided on its own.
const genericDictionaryType: common.GenericDictionaryType = {
	type: "GenericDictionary",
	generics: [
		{ name: "KeyType", defaultType: { type: "Unknown" } },
		{ name: "ValueType", defaultType: { type: "Unknown" } },
	],
}

// The Type Scope a standard library file starts from.
export const primitiveTypes: Record<string, common.Type> = {
	Boolean: booleanType,
	String: stringType,
	Integer: integerType,
	Rational: rationalType,
	Algebraic: algebraicType,
	Transcendental: transcendentalType,
	Randomness: randomnessType,
	Future: futureType,
	Started: startedType,
	Record: recordType,
	List: genericListType,
	Dictionary: genericDictionaryType,
}
