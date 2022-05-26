export type NumberType = { $type: "Number"; value: string }

export function createNumber(value: string): NumberType {
	return { $type: "Number", value }
}

export function add(originalNumber: NumberType, other: NumberType): NumberType {
	return createNumber((Number.parseFloat(originalNumber.value) + Number.parseFloat(other.value)).toString())
}

export function subtract(originalNumber: NumberType, other: NumberType): NumberType {
	return createNumber((Number.parseFloat(originalNumber.value) - Number.parseFloat(other.value)).toString())
}

export function divide(originalNumber: NumberType, other: NumberType): NumberType {
	return createNumber((Number.parseFloat(originalNumber.value) / Number.parseFloat(other.value)).toString())
}

export function multiply(originalNumber: NumberType, other: NumberType): NumberType {
	return createNumber((Number.parseFloat(originalNumber.value) * Number.parseFloat(other.value)).toString())
}
