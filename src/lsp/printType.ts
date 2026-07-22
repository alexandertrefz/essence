import type { common } from "../interfaces/index"

// NOTE: A human-oriented Type printer for Hovers. The Validator's
// `describeType` is its Diagnostics-oriented sibling — unlike it, this one
// prints full Function signatures instead of collapsing them to "Function".
export function printType(type: common.Type): string {
	switch (type.type) {
		case "UnionType":
			// NOTE: A Choice's Union prints as the Choice's name — spelling
			// out every Case would drown the Hover. An applied Generic Alias
			// prints as applied: `Optional<Integer>`.
			if (type.name !== undefined) {
				return type.name
			}

			if (type.alias !== undefined) {
				return `${type.alias.name}<${type.alias.typeArguments
					.map(printType)
					.join(", ")}>`
			}

			return type.types.map(printType).join(" | ")
		case "Case":
			return `${type.choice}#${type.name}`
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
			return printSignatureSummary(type.overloads)
		case "Namespace":
		case "GenericUse":
		case "GenericAlias":
			return type.name
		default:
			return type.type
	}
}

// NOTE: A Namespace's conformance list, rendered the way it is declared —
// ` is Equatable, is Printable, is Comparable where ItemType is Comparable`.
// The first clause follows the `for Target` half with just a space (as in the
// declaration itself); the later clauses are comma-separated. An unconditional
// clause drops its `where`; a conditional one spells every
// `Generic is Protocol` condition.
export function printConformanceClauses(
	conformsTo: Array<{
		name: string
		conditions: Array<{ generic: string; protocol: string }>
	}>,
): string {
	return conformsTo
		.map((clause, index) => {
			let where =
				clause.conditions.length === 0
					? ""
					: ` where ${clause.conditions
							.map(
								(condition) =>
									`${condition.generic} is ${condition.protocol}`,
							)
							.join(", ")}`

			return `${index === 0 ? " " : ", "}is ${clause.name}${where}`
		})
		.join("")
}

// NOTE: A Case with its payload shape spelled out — for Hovers where the
// Case itself is the subject rather than a mention. `printType` deliberately
// stays terse (`CalculatorOperation#Add`); this is the descriptive form.
export function printCaseWithPayload(caseType: common.CaseType): string {
	let members = Object.entries(caseType.members).map(
		([memberName, memberType]) => `${memberName}: ${printType(memberType)}`,
	)

	return members.length === 0
		? `${caseType.choice}#${caseType.name}`
		: `${caseType.choice}#${caseType.name} { ${members.join(", ")} }`
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

// NOTE: The signatures a call site can actually invoke: an Overload set
// expands to one entry per Overload rather than collapsing into a single
// combined Type, and Self is stripped where a call site does not pass it.
// Returns null for everything that is not callable.
export function signaturesOf(
	type: common.Type,
): Array<common.BaseFunction> | null {
	switch (type.type) {
		case "Function":
		case "StaticMethod":
			return [type]
		case "SimpleMethod":
			return [withoutSelf(type)]
		case "OverloadedStaticMethod":
			return type.overloads
		case "OverloadedMethod":
			return type.overloads.map(withoutSelf)
		default:
			return null
	}
}

// NOTE: Where only one line is available — a Completion's detail, or a
// Function Type nested inside another Type — the remaining Overloads are
// counted instead of spelled out.
export function printSignatureSummary(
	signatures: Array<common.BaseFunction>,
	name: string = "",
): string {
	let [first, ...rest] = signatures

	if (first === undefined) {
		return `${name}()`
	}

	if (rest.length === 0) {
		return printSignature(first, name)
	}

	return `${printSignature(first, name)} (+${rest.length} overload${
		rest.length === 1 ? "" : "s"
	})`
}

export function printSignature(
	functionType: common.BaseFunction,
	name: string = "",
): string {
	return describeSignature(functionType, name).label
}

// NOTE: Offsets into a signature's label, in UTF-16 code units. Signature
// Help highlights the active Parameter by range rather than by matching its
// printed text, which would otherwise always land on the first of two
// identically printed Parameters — `(_ Integer, _ Integer)` is common.
export type ParameterRange = [number, number]

export type SignatureDescription = {
	label: string
	parameters: Array<ParameterRange>
}

export function describeSignature(
	functionType: common.BaseFunction,
	name: string = "",
): SignatureDescription {
	let generics =
		functionType.generics.length === 0
			? ""
			: `<${functionType.generics
					.map((generic) =>
						// NOTE: A Protocol-bounded Type Parameter reads back as it
						// is written — `ItemType is Comparable` — so a Hover or
						// Signature Help over `sorted` shows the bound its ordering
						// depends on rather than a bare `ItemType`.
						generic.constraint == null
							? generic.name
							: `${generic.name} is ${generic.constraint}`,
					)
					.join(", ")}>`

	let label = `${name}${generics}(`
	let parameters: Array<ParameterRange> = []

	for (let [index, parameter] of functionType.parameterTypes.entries()) {
		if (index > 0) {
			label += ", "
		}

		let text = printParameter(parameter)

		parameters.push([label.length, label.length + text.length])
		label += text
	}

	label += `) -> ${printType(functionType.returnType)}`

	return { label, parameters }
}

function printParameter(
	parameter: common.BaseFunction["parameterTypes"][number],
): string {
	return parameter.name === null
		? `_ ${printType(parameter.type)}`
		: `${parameter.name}: ${printType(parameter.type)}`
}
