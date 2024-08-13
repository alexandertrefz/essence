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

export type StringType = {
	type: "String"
}

export type IntegerType = {
	type: "Integer"
}

export type FractionType = {
	type: "Fraction"
}

export type BooleanType = {
	type: "Boolean"
}

export type NothingType = {
	type: "Nothing"
}

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
	properties: Record<string, Type>
	methods: Record<string, MethodType>
}

export type UnionType = {
	type: "UnionType"
	types: Array<Type>
}

export type PrimitiveType =
	| NothingType
	| StringType
	| IntegerType
	| FractionType
	| BooleanType
	| RecordType
	| FunctionType
	| NamespaceType

export type Type = UnknownType | PrimitiveType | UnionType | MethodType

export { typed, typedSimple }
