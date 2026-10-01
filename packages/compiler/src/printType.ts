import type { common } from "@essence-lang/interfaces"

import {
	displayChoiceName,
	displayGenericName,
	displayProtocolName,
	displayedRefinementArguments,
} from "./helpers/describe"

// How a printed bound names a Protocol, by identity. A language server request
// sets it for its document; everything else prints the declared name.
let protocolSpeller: (identity: string) => string = displayProtocolName

export function withProtocolSpellings<Value>(
	spell: (identity: string) => string,
	run: () => Value,
): Value {
	let outer = protocolSpeller

	protocolSpeller = spell

	try {
		return run()
	} finally {
		protocolSpeller = outer
	}
}

export function spellProtocol(identity: string): string {
	return protocolSpeller(identity)
}

// The Type printer for editor features; `describeType` is the one for
// Diagnostics. An inlay hint's Type can be applied as an edit. So a Parameter
// with a default has no `?` mark here, which would lex as part of its label.
export function printType(type: common.Type): string {
	switch (type.type) {
		case "UnionType":
			// A Choice prints as its name, and an applied Generic Alias as
			// applied, such as `Optional<Integer>`.
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
			return caseHeader(type)
		// A refinement prints as its alias, applied where it is generic.
		case "Refinement": {
			let typeArguments = displayedRefinementArguments(type)

			return typeArguments === null
				? type.name
				: `${type.name}<${typeArguments.map(printType).join(", ")}>`
		}
		case "List":
			return `List<${printType(type.itemType)}>`
		case "GenericList":
			return "List"
		// An unapplied `Future` prints as `Future<Unknown>`.
		case "Future":
			return `Future<${printType(type.valueType)}>`
		case "Started":
			return `Started<${printType(type.valueType)}>`
		case "Dictionary":
			return `Dictionary<${printType(type.keyType)}, ${printType(
				type.valueType,
			)}>`
		case "GenericDictionary":
			return "Dictionary"
		// A Record reached through an Alias prints as the Alias.
		// `printRecordWithMembers` spells out the members.
		case "Record":
			if (type.name !== undefined) {
				return type.name
			}

			if (type.alias !== undefined) {
				return `${type.alias.name}<${type.alias.typeArguments
					.map(printType)
					.join(", ")}>`
			}

			return printRecordWithMembers(type)
		// A Function prints as a declaration's signature, which a Type
		// annotation does not accept. `isSpellableType` refuses every Function,
		// so no edit writes one back.
		case "Function":
		case "SimpleMethod":
		case "StaticMethod":
			return printSignature(type, "", { marksOmittable: false })
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return printSignatureSummary(type.overloads, "", {
				marksOmittable: false,
			})
		case "Namespace":
			return type.name
		// The written name, never a freshened one. See `displayGenericName`.
		case "GenericUse":
		case "GenericAlias":
			return displayGenericName(type.name)
		default:
			return type.type
	}
}

// A Namespace's conformance list as declared, such as
// ` is Equatable, is Comparable where ItemType is Comparable`.
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

// The `Choice#Case` head, applied as `Step<Integer, String>#Done` when a Type
// Argument is bound. The Choice is named as declared, so no Module path reaches
// the editor.
export function caseHeader(caseType: common.CaseType): string {
	let choiceName = displayChoiceName(caseType.choice)

	if (
		caseType.typeArguments !== undefined &&
		caseType.typeArguments.some(
			(argument) => argument.type !== "GenericUse",
		)
	) {
		return `${choiceName}<${caseType.typeArguments
			.map(printType)
			.join(", ")}>#${caseType.name}`
	}

	return `${choiceName}#${caseType.name}`
}

// A Record with its members spelled out, for a Hover over its Alias's own
// Declaration.
export function printRecordWithMembers(type: common.RecordType): string {
	let members = Object.entries(type.members).map(
		([memberName, memberType]) => `${memberName}: ${printType(memberType)}`,
	)

	return members.length === 0 ? "{}" : `{ ${members.join(", ")} }`
}

// A Case with its payload spelled out, for a Hover about the Case itself.
export function printCaseWithPayload(caseType: common.CaseType): string {
	let members = Object.entries(caseType.members).map(
		([memberName, memberType]) => `${memberName}: ${printType(memberType)}`,
	)

	return members.length === 0
		? caseHeader(caseType)
		: `${caseHeader(caseType)} { ${members.join(", ")} }`
}

// A Method's first Parameter is Self, which a `::` call does not pass.
export function withoutSelf(
	functionType: common.BaseFunction,
): common.BaseFunction {
	return {
		...functionType,
		parameterTypes: functionType.parameterTypes.slice(1),
	}
}

// The signatures a call can invoke, one per Overload and without Self. Null
// for anything not callable.
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

// The first signature, counting the other Overloads, for where one line is
// all there is.
export function printSignatureSummary(
	signatures: Array<common.BaseFunction>,
	name: string = "",
	printing: SignaturePrinting = {},
): string {
	let [first, ...rest] = signatures

	if (first === undefined) {
		return `${name}()`
	}

	if (rest.length === 0) {
		return printSignature(first, name, printing)
	}

	return `${printSignature(first, name, printing)} (+${rest.length} overload${
		rest.length === 1 ? "" : "s"
	})`
}

// Whether a Parameter with a default is marked `?`. Off where the text may be
// written back as source.
type SignaturePrinting = { marksOmittable?: boolean }

export function printSignature(
	functionType: common.BaseFunction,
	name: string = "",
	printing: SignaturePrinting = {},
): string {
	return describeSignature(functionType, name, printing).label
}

// Offsets into a signature's label, in UTF-16 code units. Signature Help
// highlights by range, since two Parameters can print alike.
export type ParameterRange = [number, number]

type SignatureDescription = {
	label: string
	parameters: Array<ParameterRange>
}

export function describeSignature(
	functionType: common.BaseFunction,
	name: string = "",
	printing: SignaturePrinting = {},
): SignatureDescription {
	// A provided Method is generic over `Self`, which nobody writes and the
	// receiver binds, so it is never shown.
	let declaredGenerics = functionType.generics.filter(
		(generic) => generic.name !== "Self",
	)
	let generics =
		declaredGenerics.length === 0
			? ""
			: `<${declaredGenerics
					.map((generic) =>
						// A bound prints as written, `ItemType is Comparable`.
						generic.constraint == null
							? generic.name
							: `${generic.name} is ${spellProtocol(generic.constraint)}`,
					)
					.join(", ")}>`

	let label = `${name}${generics}(`
	let parameters: Array<ParameterRange> = []

	for (let [index, parameter] of functionType.parameterTypes.entries()) {
		if (index > 0) {
			label += ", "
		}

		let text = printParameter(parameter, printing)

		parameters.push([label.length, label.length + text.length])
		label += text
	}

	label += `) -> ${printType(functionType.returnType)}`

	return { label, parameters }
}

// A Parameter with a default reads `at?: Side`, since a Type carries no
// Expression to print. The `?` sits inside the Parameter's range, so Signature
// Help highlights it too.
function printParameter(
	parameter: common.BaseFunction["parameterTypes"][number],
	printing: SignaturePrinting,
): string {
	let optional =
		parameter.hasDefault && printing.marksOmittable !== false ? "?" : ""

	return parameter.name === null
		? `_${optional} ${printType(parameter.type)}`
		: `${parameter.name}${optional}: ${printType(parameter.type)}`
}
