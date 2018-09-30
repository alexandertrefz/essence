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

export type FunctionType = {
	type: "Function"
	parameterTypes: Array<Parameter>
	returnType: Type
}

export type UnstaticMethodType = {
	type: "Method"
	parameterTypes: Array<Parameter>
	returnType: Type
	isStatic: false
	isOverloaded: false
}

export type StaticMethodType = {
	type: "Method"
	parameterTypes: Array<Parameter>
	returnType: Type
	isStatic: true
	isOverloaded: false
}

export type StaticOverloadedMethodType = {
	type: "Method"
	parameterTypes: Array<Array<Parameter>>
	returnType: Type
	isStatic: true
	isOverloaded: true
}

export type UnstaticOverloadedMethodType = {
	type: "Method"
	parameterTypes: Array<Array<Parameter>>
	returnType: Type
	isStatic: false
	isOverloaded: true
}

export type MethodType =
	| UnstaticMethodType
	| StaticMethodType
	| StaticOverloadedMethodType
	| UnstaticOverloadedMethodType

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

export type Type = RecordType | FunctionType | MethodType | PrimitiveType | TypeType | ListType | UnknownType

export { typed, typedSimple }
