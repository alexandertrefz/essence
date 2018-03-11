import { $Boolean, BooleanType } from "./Boolean"
import { $Array, ArrayType } from "./Array"

export type StringType = { $type: "String"; value: string }

export class $String {
	static create(value: string): StringType {
		return { $type: "String", value }
	}

	static isEmpty(originalString: StringType): BooleanType {
		return $Boolean.create(originalString.value.length === 0)
	}

	static hasContent(originalString: StringType): BooleanType {
		return $Boolean.create(originalString.value.length !== 0)
	}

	static is(originalString: StringType, otherString: StringType): BooleanType {
		return $Boolean.create(originalString.value === otherString.value)
	}

	static isnt(originalString: StringType, otherString: StringType): BooleanType {
		return $Boolean.create(originalString.value !== otherString.value)
	}

	static prepend(originalString: StringType, otherString: StringType): StringType {
		return $String.create(otherString.value + originalString.value)
	}

	static append(originalString: StringType, otherString: StringType): StringType {
		return $String.create(originalString.value + otherString.value)
	}

	static split(originalString: StringType, splitterString: StringType): ArrayType<StringType> {
		return $Array.create(originalString.value.split(splitterString.value).map(chunk => $String.create(chunk)))
	}

	static contains(originalString: StringType, otherString: StringType): BooleanType {
		return $Boolean.create(originalString.value.includes(otherString.value))
	}
}
