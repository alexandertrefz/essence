import type { common } from "../interfaces"

// NOTE: A human-oriented Type printer for Hovers. The Validator's
// `describeType` is its Diagnostics-oriented sibling — unlike it, this one
// prints full Function signatures instead of collapsing them to "Function".
export function printType(type: common.Type): string {
	switch (type.type) {
		case "UnionType":
			return type.types.map(printType).join(" | ")
		case "List":
			return `List<${printType(type.itemType)}>`
		case "GenericList":
			return "List"
		case "Record": {
			let members = Object.entries(type.members).map(
				([memberName, memberType]) =>
					`${memberName}: ${printType(memberType)}`,
			)

			return members.length === 0 ? "{}" : `{ ${members.join(", ")} }`
		}
		case "Function":
		case "SimpleMethod":
		case "StaticMethod":
			return printSignature(type)
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return type.overloads.map(printSignature).join(" & ")
		case "Namespace":
		case "GenericUse":
		case "GenericAlias":
			return type.name
		default:
			return type.type
	}
}

// NOTE: Non-static Methods carry Self as their first Parameter Type — for
// display it is stripped, so the signature matches what a `::` call site
// actually passes.
export function withoutSelf(
	functionType: common.BaseFunction,
): common.BaseFunction {
	return {
		...functionType,
		parameterTypes: functionType.parameterTypes.slice(1),
	}
}

export function printSignature(functionType: common.BaseFunction): string {
	let generics =
		functionType.generics.length === 0
			? ""
			: `<${functionType.generics
					.map((generic) => generic.name)
					.join(", ")}>`

	let parameters = functionType.parameterTypes.map((parameter) =>
		parameter.name === null
			? `_ ${printType(parameter.type)}`
			: `${parameter.name}: ${printType(parameter.type)}`,
	)

	return `${generics}(${parameters.join(", ")}) -> ${printType(
		functionType.returnType,
	)}`
}
