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

// TODO: Represent Parameter Labels as part of the type
export type FunctionType = {
	type: "Function"
	parameterTypes: Array<Type>
	returnType: Type
}

// TODO: Represent Parameter Labels as part of the type
export type UnstaticMethodType = {
	type: "Method"
	parameterTypes: Array<Type>
	returnType: Type
	isStatic: false
}

// TODO: Represent Parameter Labels as part of the type
export type StaticMethodType = {
	type: "Method"
	parameterTypes: Array<Type>
	returnType: Type
	isStatic: true
}

export type MethodType = UnstaticMethodType | StaticMethodType

export type ArrayType = {
	type: "Array"
	itemType: RecordType | FunctionType | PrimitiveType | TypeType | ArrayType | NeverType
}

export type PrimitiveType = {
	type: "Primitive"
	primitive: "String" | "Number" | "Boolean"
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
	definition: RecordType | BuiltInType | PrimitiveType
	methods: {
		[key: string]: MethodType
	}
}

export type Type = RecordType | FunctionType | MethodType | PrimitiveType | TypeType | ArrayType

export { typed, typedSimple }
