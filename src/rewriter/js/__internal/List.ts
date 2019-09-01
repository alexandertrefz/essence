import $Boolean, { BooleanType } from "./Boolean"
import { NumberType } from "./Number"
import { getRawNumber } from "./internalHelpers"

export type ListType<T> = { $type: "List"; value: Array<T> }

export default class $List {
	static create<T>(originalList: Array<T>): ListType<T> {
		return { $type: "List", value: originalList }
	}

	static hasItems<T>(originalList: ListType<T>): BooleanType {
		return $Boolean.create(originalList.value.length !== 0)
	}

	static first<T>(originalList: ListType<T>): T {
		return originalList.value[0]
	}

	static last<T>(originalList: ListType<T>): T {
		return originalList.value[originalList.value.length - 1]
	}

	static unique<T>(originalList: ListType<T>): ListType<T> {
		let results: Array<T> = []

		originalList.value.map(value => {
			if (!results.includes(value)) {
				results.push(value)
			}
		})

		return $List.create(results)
	}

	static dropFirst<T>(originalList: ListType<T>): ListType<T> {
		return $List.create(originalList.value.slice(1))
	}

	static dropLast<T>(originalList: ListType<T>): ListType<T> {
		return $List.create(originalList.value.slice(0, originalList.value.length - 1))
	}

	static insert__overload$1<T>(originalList: ListType<T>, item: T, index: NumberType): ListType<T> {
		return $List.create(originalList.value.splice(getRawNumber(index), 1, item))
	}

	static insert__overload$2<T>(originalList: ListType<T>, contentsOf: ListType<T>, index: NumberType): ListType<T> {
		return $List.create(
			originalList.value.splice(getRawNumber(index), contentsOf.value.length, ...contentsOf.value),
		)
	}

	static append__overload$1<T>(originalList: ListType<T>, item: T): ListType<T> {
		return $List.create([...originalList.value, item])
	}

	static append__overload$2<T>(originalList: ListType<T>, contentsOf: ListType<T>): ListType<T> {
		return $List.create([...originalList.value, ...contentsOf.value])
	}
}
