import { common } from "../../interfaces"

const type: common.TypeType = {
	type: "Type",
	name: "Fraction",
	definition: { type: "Primitive", primitive: "Fraction" },
	methods: {
		divide: {
			type: "OverloadedMethod",
			parameterTypes: [
				[
					{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
					{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
				],
				[
					{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
					{ name: null, type: { type: "Primitive", primitive: "Integer" } },
				],
			],
			returnType: { type: "Primitive", primitive: "Fraction" },
		},
	},
}

export default type
