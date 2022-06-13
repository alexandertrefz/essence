export type BooleanType = { $type: "Boolean"; value: boolean }

export function createBoolean(value: boolean): BooleanType {
	return { $type: "Boolean", value }
}

export function negate(originalBoolean: BooleanType): BooleanType {
	return createBoolean(!originalBoolean.value)
}

export function is(originalBoolean: BooleanType, other: BooleanType): BooleanType {
	return createBoolean(originalBoolean.value === other.value)
}

export function isnt(originalBoolean: BooleanType, other: BooleanType): BooleanType {
	return createBoolean(originalBoolean.value !== other.value)
}
