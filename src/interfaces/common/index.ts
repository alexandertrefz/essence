import * as typed from "./typedNodes"
import * as typedSimple from "./typedSimpleNodes"

export type Cursor = {
	line: number
	column: number
}

export type Position = {
	start: Cursor
	end: Cursor
}

export type DiagnosticSeverity = "error" | "warning"

// NOTE: `unnecessary` renders the code greyed out rather than underlined —
// for Diagnostics about code that has no effect instead of code that is
// wrong.
export type DiagnosticTag = "unnecessary" | "deprecated"

export type Diagnostic = {
	severity: DiagnosticSeverity
	message: string
	position: Position | null
	// NOTE: A stable identifier for the kind of Diagnostic, independent of
	// the message wording — what a Language Server client keys Quick Fixes
	// off, and what lets a message be reworded without breaking them.
	code?: DiagnosticCode
	tags?: Array<DiagnosticTag>
}

export type DiagnosticCode =
	| "missing-case"
	| "unreachable-case"
	| "missing-return"
	| "constant-reassignment"
	| "unknown-name"
	| "internal-error"

export type UnknownType = {
	type: "Unknown"
}

export type ErrorType = {
	type: "Error"
}

export type NothingType = {
	type: "Nothing"
}

export type BooleanType = {
	type: "Boolean"
}

export type StringType = {
	type: "String"
}

export type IntegerType = {
	type: "Integer"
}

export type FractionType = {
	type: "Fraction"
}

export type RecordType = {
	type: "Record"
	members: Record<string, Type>
}

export type GenericListType = {
	type: "GenericList"
	generics: [{ name: "ItemType"; defaultType: { type: "Unknown" } }]
}

export type ListType = {
	type: "List"
	itemType: Type
}

type Parameter = {
	type: Type | GenericUse
	name: string | null
}

export type BaseFunction = {
	parameterTypes: Array<
		| Parameter
		| {
				type: GenericUse
				name: string | null
		  }
	>
	generics: Array<GenericDeclaration>
	returnType: Type | GenericUse
}

export type FunctionType = BaseFunction & {
	type: "Function"
}

export type SimpleMethodType = BaseFunction & {
	type: "SimpleMethod"
}

export type StaticMethodType = BaseFunction & {
	type: "StaticMethod"
}

export type OverloadedStaticMethodType = {
	type: "OverloadedStaticMethod"
	overloads: Array<BaseFunction>
}

export type OverloadedMethodType = {
	type: "OverloadedMethod"
	overloads: Array<BaseFunction>
}

export type MethodType =
	| SimpleMethodType
	| StaticMethodType
	| OverloadedStaticMethodType
	| OverloadedMethodType

export type PrimitiveType =
	| NothingType
	| BooleanType
	| StringType
	| IntegerType
	| FractionType
	| RecordType
	| ListType
	| FunctionType
	| NamespaceType

export type NamespaceType = {
	type: "Namespace"
	targetType: Type | null
	name: string
	generics: Array<GenericDeclaration>
	properties: Record<string, Type | GenericUse>
	methods: Record<string, MethodType>
}

export type UnionType = {
	type: "UnionType"
	types: Array<Type | GenericUse>
}

export type GenericName = string

export type GenericDeclaration = {
	name: GenericName
	infer: boolean
	defaultType: Type | null
}

export type GenericUse = {
	type: "GenericUse"
	name: GenericName
}

// NOTE: The unapplied form of a generic Type Alias — use sites apply Type
// Arguments (`Maybe<Fraction>`), which substitutes them into `aliasedType`.
export type GenericAliasType = {
	type: "GenericAlias"
	name: string
	generics: Array<GenericDeclaration>
	aliasedType: Type
}

export type Type =
	| UnknownType
	| ErrorType
	| PrimitiveType
	| UnionType
	| MethodType
	| GenericListType
	| GenericAliasType
	| GenericUse

export { typed, typedSimple }
