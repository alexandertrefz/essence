export type BooleanType = { $type: "Boolean"; value: boolean }

export class $Boolean {
	static create(value: boolean): BooleanType {
		return { $type: "Boolean", value }
	}

	static negate(self: BooleanType): BooleanType {
		return $Boolean.create(!self.value)
	}

	static is(self: BooleanType, other: BooleanType): BooleanType {
		return $Boolean.create(self.value === other.value)
	}
}
