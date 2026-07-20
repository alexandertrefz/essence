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

// NOTE: What a `§§` block above a Declaration says about it. `description` is
// Markdown, as the Language Server hands it to the Editor unchanged; the
// tagged sections are lifted out of it so that each can be shown where it
// belongs — a Parameter's text next to that Parameter rather than in one
// undifferentiated blob.
export type Documentation = {
	description: string
	parameters: Record<string, string>
	returns: string | null
	// NOTE: Null for the hand written builtin Namespaces — they document
	// themselves in TypeScript rather than in a `§§` block, so there is no
	// Essence source to point back at.
	position: Position | null
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

export type Parameter = {
	type: Type | GenericUse
	name: string | null
	// NOTE: What the Declaration's `§§` block says about this Parameter, so
	// Signature Help can describe the Argument being typed rather than the
	// call as a whole.
	documentation?: string
}

// NOTE: `documentation` is optional throughout, so that the hand written
// builtin Namespaces in `enricher/types` stay valid while they are documented
// one Method at a time.
export type BaseFunction = {
	parameterTypes: Array<Parameter>
	generics: Array<GenericDeclaration>
	returnType: Type | GenericUse
	documentation?: Documentation
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

// NOTE: The Overloaded kinds are not `BaseFunction`s, so a `§§` block above
// the `overload` keyword documents the set as a whole — each Overload
// separately documents itself, and falls back to the set's text.
export type OverloadedStaticMethodType = {
	type: "OverloadedStaticMethod"
	overloads: Array<BaseFunction>
	documentation?: Documentation
}

export type OverloadedMethodType = {
	type: "OverloadedMethod"
	overloads: Array<BaseFunction>
	documentation?: Documentation
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
