import { $Boolean, BooleanType } from "./Boolean"

export type ArrayType<T> = { $type: "Array"; value: Array<T> }

export class $Array {
	static create<T>(value: Array<T>): ArrayType<T> {
		return { $type: "Array", value }
	}

	static hasItems<T>(value: ArrayType<T>): BooleanType {
		return $Boolean.create(value.value.length !== 0)
	}

	static first<T>(value: ArrayType<T>): T {
		return value.value[0]
	}

	static last<T>(value: ArrayType<T>): T {
		return value.value[value.value.length - 1]
	}

	static unique<T>(value: ArrayType<T>): ArrayType<T> {
		let cache: Array<T> = []
		return $Array.create(value.value.filter(value => !~cache.indexOf(value)))
	}

	static dropFirst<T>(value: ArrayType<T>): ArrayType<T> {
		return $Array.create(value.value.slice(1))
	}
}
