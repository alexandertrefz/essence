export type BooleanType = { $type: "Boolean"; value: boolean }

export class $Boolean {
	static create(value: boolean): BooleanType {
		return { $type: "Boolean", value }
	}
}
