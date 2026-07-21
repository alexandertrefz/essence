import type { common } from "../interfaces/index"
import {
	namespace as algebraicNamespace,
	type as algebraicType,
} from "./types/Algebraic"
import {
	namespace as booleanNamespace,
	type as booleanType,
} from "./types/Boolean"
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
// Program. The Enricher builds its top-level Scope from these tables, and the
// Language Server derives its builtin listings from the same tables — a new
// builtin registered here reaches resolution, completion, rename and
// semantic tokens in one step, and can not be half-wired again.

// NOTE: `Irrational` is a transparent alias for `Algebraic | Transcendental`
// — the pair are definitional complements (transcendental means "not
// algebraic"), so the alias covers exactly the representable irrationals and
// makes `π is Irrational` a true sentence.
const irrationalType: common.UnionType = {
	type: "UnionType",
	name: "Irrational",
	types: [algebraicType, transcendentalType],
}

export const builtinMembers: Record<string, common.Type> = {
	...nativeFunctions,
	String: stringNamespace,
	Boolean: booleanNamespace,
	Integer: integerNamespace,
	Rational: rationalNamespace,
	Algebraic: algebraicNamespace,
	Transcendental: transcendentalNamespace,
	Number: numberNamespace,
	Nothing: nothingNamespace,
	Ordering: orderingNamespace,
	Record: recordNamespace,
	List: listNamespace,
}

export const builtinTypes: Record<string, common.Type> = {
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
	Ordering: orderingType,
}

export const builtinProtocols: Record<string, common.ProtocolType> = {
	Equatable,
	Printable,
	Comparable,
}

export const builtinNamespaces: Array<common.NamespaceType> = Object.values(
	builtinMembers,
).filter(
	(member): member is common.NamespaceType => member.type === "Namespace",
)
