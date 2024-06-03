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

export type GenericType = {
	type: "Generic"
	name: string
}

export type RecordType = {
	type: "Record"
	members: Record<string, Type>
}

type Parameter = {
	type: Type
	name: string | null
}

type GenericDeclaration = {
	name: string
	defaultType: Type | null
}

export type FunctionType = {
	type: "Function"
	parameterTypes: Array<Parameter>
	returnType: Type
}

export type GenericFunctionType = {
	type: "GenericFunction"
	generics: Array<GenericDeclaration>
	parameterTypes: Array<Parameter>
	returnType: Type
}

export type SimpleMethodType = {
	type: "SimpleMethod"
	parameterTypes: Array<Parameter>
	returnType: Type
}

export type StaticMethodType = {
	type: "StaticMethod"
	parameterTypes: Array<Parameter>
	returnType: Type
}

export type OverloadedStaticMethodType = {
	type: "OverloadedStaticMethod"
	overloads: Array<{ parameterTypes: Array<Parameter>; returnType: Type }>
}

export type OverloadedMethodType = {
	type: "OverloadedMethod"
	overloads: Array<{ parameterTypes: Array<Parameter>; returnType: Type }>
}

export type MethodType =
	| SimpleMethodType
	| StaticMethodType
	| OverloadedStaticMethodType
	| OverloadedMethodType

export type ListType = {
	type: "List"
	itemType: Type
}

export type StringPrimitiveType = {
	type: "Primitive"
	primitive: "String"
}

export type IntegerPrimitiveType = {
	type: "Primitive"
	primitive: "Integer"
}

export type FractionPrimitiveType = {
	type: "Primitive"
	primitive: "Fraction"
}

export type BooleanPrimitiveType = {
	type: "Primitive"
	primitive: "Boolean"
}

export type NothingPrimitiveType = {
	type: "Primitive"
	primitive: "Nothing"
}

export type PrimitiveType =
	| StringPrimitiveType
	| IntegerPrimitiveType
	| FractionPrimitiveType
	| BooleanPrimitiveType
	| NothingPrimitiveType

export type UnknownType = {
	type: "Unknown"
}

export type BuiltInType = {
	type: "BuiltIn"
}

export type NamespaceType = {
	type: "Namespace"
	targetType: Type | null
	name: string
	definition: RecordType
	methods: Record<string, MethodType>
}

export type UnionType = {
	type: "UnionType"
	types: Array<Type>
}

export type Type =
	| RecordType
	| FunctionType
	| GenericFunctionType
	| MethodType
	| PrimitiveType
	| NamespaceType
	| ListType
	| UnknownType
	| GenericType
	| UnionType

export { typed, typedSimple }
