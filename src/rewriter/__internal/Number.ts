export type NumberType = { $type: "Number"; value: bigint }

export function createNumber(value: bigint): NumberType {
	return { $type: "Number", value }
}

export function add(originalNumber: NumberType, other: NumberType): NumberType {
	return createNumber(originalNumber.value + other.value)
}

export function subtract(originalNumber: NumberType, other: NumberType): NumberType {
	return createNumber(originalNumber.value - other.value)
}

export function divide(originalNumber: NumberType, other: NumberType): NumberType {
	return createNumber(originalNumber.value / other.value)
}

export function multiply(originalNumber: NumberType, other: NumberType): NumberType {
	return createNumber(originalNumber.value * other.value)
}
