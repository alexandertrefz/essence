export type BooleanType = { $type: "Boolean"; value: boolean }

export class $Boolean {
	static create(value: boolean): BooleanType {
		return { $type: "Boolean", value }
	}

	static negate(originalBoolean: BooleanType): BooleanType {
		return $Boolean.create(!originalBoolean.value)
	}

	static is(originalBoolean: BooleanType, other: BooleanType): BooleanType {
		return $Boolean.create(originalBoolean.value === other.value)
	}
}
