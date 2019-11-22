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
	members: {
		[key: string]: Type
	}
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
	parameterTypes: Array<Array<Parameter>>
	returnType: Type
}

export type OverloadedMethodType = {
	type: "OverloadedMethod"
	parameterTypes: Array<Array<Parameter>>
	returnType: Type
}

export type MethodType = SimpleMethodType | StaticMethodType | OverloadedStaticMethodType | OverloadedMethodType

export type ListType = {
	type: "List"
	itemType: Type
}

export type PrimitiveType = {
	type: "Primitive"
	primitive: "String" | "Number" | "Boolean"
}

export type UnknownType = {
	type: "Unknown"
}

export type BuiltInType = {
	type: "BuiltIn"
}

export type TypeType = {
	type: "Type"
	name: string
	definition: RecordType | BuiltInType | PrimitiveType
	methods: {
		[key: string]: MethodType
	}
}

export type GenericTypeType = {
	type: "GenericType"
	name: string
	definition: RecordType | BuiltInType | PrimitiveType
	generics: Array<GenericDeclaration>
	methods: {
		[key: string]: MethodType
	}
}

export type Type =
	| RecordType
	| FunctionType
	| GenericFunctionType
	| MethodType
	| PrimitiveType
	| TypeType
	| GenericTypeType
	| ListType
	| UnknownType
	| GenericType

export { typed, typedSimple }
