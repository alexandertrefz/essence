export type NumberType = { $type: "Number"; value: string }

export class $Number {
	static create(value: string): NumberType {
		return { $type: "Number", value }
	}
}
