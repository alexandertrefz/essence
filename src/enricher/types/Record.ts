import type { common } from "../../interfaces/index"

export const type: common.RecordType = { type: "Record", members: {} }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Record",
	generics: [],
	targetType: type,
	conformsTo: ["Equatable", "Printable"],
	properties: {},
	methods: {
		is: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: type,
				},
				{
					name: null,
					type: type,
					documentation: "the Record to compare against",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Checks whether the Records are structurally equal — the same members with equal values, in any order.",
				parameters: {},
				returns: "`true` when the Records are equal.",
				position: null,
			},
		},
		isNot: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: type,
				},
				{
					name: null,
					type: type,
					documentation: "the Record to compare against",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Checks whether the Records differ structurally — in their members or any member's value.",
				parameters: {},
				returns: "`true` when the Records are not equal.",
				position: null,
			},
		},
		// NOTE: `entries` and `values` exist in the runtime but stay
		// undeclared — their honest return Types need an `Anything` Type,
		// which arrives with the JSON design.
		keys: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: type,
				},
			],
			returnType: { type: "List", itemType: { type: "String" } },
			documentation: {
				description: "The names of the Record's members.",
				parameters: {},
				returns: "the member names, as a List of Strings.",
				position: null,
			},
		},
		toString: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: type,
				},
			],
			returnType: { type: "String" },
			documentation: {
				description:
					"Represents the Record and its members as a String.",
				parameters: {},
				returns: "the String representation of the Record.",
				position: null,
			},
		} as common.MethodType,
	},
}
