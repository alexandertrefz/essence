export type NumberType = { $type: "Number"; value: string }

export class $Number {
	static create(value: string): NumberType {
		return { $type: "Number", value }
	}

	static add(self: NumberType, other: NumberType): NumberType {
		return $Number.create((Number.parseFloat(self.value) + Number.parseFloat(other.value)).toString())
	}

	static subtract(self: NumberType, other: NumberType): NumberType {
		return $Number.create((Number.parseFloat(self.value) - Number.parseFloat(other.value)).toString())
	}

	static divide(self: NumberType, other: NumberType): NumberType {
		return $Number.create((Number.parseFloat(self.value) / Number.parseFloat(other.value)).toString())
	}

	static multiply(self: NumberType, other: NumberType): NumberType {
		return $Number.create((Number.parseFloat(self.value) * Number.parseFloat(other.value)).toString())
	}
}
