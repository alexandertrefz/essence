export type NumberType = { $type: "Number"; value: string }

export class $Number {
	static create(value: string): NumberType {
		return { $type: "Number", value }
	}

	static add(originalNumber: NumberType, other: NumberType): NumberType {
		return $Number.create((Number.parseFloat(originalNumber.value) + Number.parseFloat(other.value)).toString())
	}

	static subtract(originalNumber: NumberType, other: NumberType): NumberType {
		return $Number.create((Number.parseFloat(originalNumber.value) - Number.parseFloat(other.value)).toString())
	}

	static divide(originalNumber: NumberType, other: NumberType): NumberType {
		return $Number.create((Number.parseFloat(originalNumber.value) / Number.parseFloat(other.value)).toString())
	}

	static multiply(originalNumber: NumberType, other: NumberType): NumberType {
		return $Number.create((Number.parseFloat(originalNumber.value) * Number.parseFloat(other.value)).toString())
	}
}
