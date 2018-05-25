import $Boolean, { BooleanType } from "./Boolean"
import $Number, { NumberType } from "./Number"
import { getRawNumber } from "./internalHelpers"

export type ArrayType<T> = { $type: "Array"; value: Array<T> }

export default class $Array {
	static create<T>(originalArray: Array<T>): ArrayType<T> {
		return { $type: "Array", value: originalArray }
	}

	static hasItems<T>(originalArray: ArrayType<T>): BooleanType {
		return $Boolean.create(originalArray.value.length !== 0)
	}

	static first<T>(originalArray: ArrayType<T>): T {
		return originalArray.value[0]
	}

	static last<T>(originalArray: ArrayType<T>): T {
		return originalArray.value[originalArray.value.length - 1]
	}

	static unique<T>(originalArray: ArrayType<T>): ArrayType<T> {
		let results: Array<T> = []

		originalArray.value.map(value => {
			if (!results.includes(value)) {
				results.push(value)
			}
		})

		return $Array.create(results)
	}

	static dropFirst<T>(originalArray: ArrayType<T>): ArrayType<T> {
		return $Array.create(originalArray.value.slice(1))
	}

	static dropLast<T>(originalArray: ArrayType<T>): ArrayType<T> {
		return $Array.create(originalArray.value.slice(0, originalArray.value.length - 1))
	}

	static insert$1<T>(originalArray: ArrayType<T>, item: T, index: NumberType): ArrayType<T> {
		return $Array.create(originalArray.value.splice(getRawNumber(index), 1, item))
	}

	// TODO: Figure out overrides
	static insert$2<T>(originalArray: ArrayType<T>, contentsOf: ArrayType<T>, index: NumberType): ArrayType<T> {
		return $Array.create(
			originalArray.value.splice(getRawNumber(index), contentsOf.value.length, ...contentsOf.value),
		)
	}

	static append$1<T>(originalArray: ArrayType<T>, item: T): ArrayType<T> {
		return $Array.create([...originalArray.value, item])
	}

	static append$2<T>(originalArray: ArrayType<T>, contentsOf: ArrayType<T>): ArrayType<T> {
		return $Array.create([...originalArray.value, ...contentsOf.value])
	}
}
