import { $Boolean, BooleanType } from "./Boolean"
import { $Array, ArrayType } from "./Array"

export type StringType = { $type: "String"; value: string }

export class $String {
	static create(value: string): StringType {
		return { $type: "String", value }
	}

	static isEmpty(self: StringType): BooleanType {
		return $Boolean.create(self.value.length === 0)
	}

	static hasContent(self: StringType): BooleanType {
		return $Boolean.create(self.value.length !== 0)
	}

	static is(self: StringType, otherString: StringType): BooleanType {
		return $Boolean.create(self.value === otherString.value)
	}

	static isnt(self: StringType, otherString: StringType): BooleanType {
		return $Boolean.create(self.value !== otherString.value)
	}

	static prepend(self: StringType, otherString: StringType): StringType {
		return $String.create(otherString.value + self.value)
	}

	static append(self: StringType, otherString: StringType): StringType {
		return $String.create(self.value + otherString.value)
	}

	static split(self: StringType, splitter: StringType): ArrayType<StringType> {
		return $Array.create(self.value.split(splitter.value).map(chunk => $String.create(chunk)))
	}

	static contains(self: StringType, otherString: StringType): BooleanType {
		return $Boolean.create(self.value.includes(otherString.value))
	}
}
