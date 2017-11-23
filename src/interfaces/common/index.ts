import * as typed from "./typedNodes"
import * as typedSimple from "./typedSimpleNodes"

export type Position = {
	line: number
	column: number
}

export type RecordType = {
	type: "Record"
	members: {
		[key: string]: Type
	}
}

export type FunctionType = {
	type: "Function"
	parameterTypes: Array<Type>
	returnType: Type
}

export type MethodType = {
	type: "Method"
	parameterTypes: Array<Type | SelfType>
	returnType: Type | SelfType | GenericType
	isStatic: boolean
}

export type ArrayType = {
	type: "Array"
	itemType: Type | GenericType | NeverType | SelfType
}

export type PrimitiveType = {
	type: "Primitive"
	primitive: "String" | "Number" | "Boolean"
}

export type GenericType = {
	type: "Generic"
}

export type SelfType = {
	type: "Self"
}

export type NeverType = {
	type: "Never"
}

export type BuiltInType = {
	type: "BuiltIn"
}

export type TypeType = {
	type: "Type"
	name: string
	definition: RecordType | BuiltInType
	methods: {
		[key: string]: MethodType
	}
}

export type Type = RecordType | FunctionType | MethodType | PrimitiveType | TypeType | ArrayType

export { typed, typedSimple }
