import type { common } from "@essence-lang/interfaces"

import { primary, reportError, secondary } from "../diagnostics/index"
import {
	anyFailedReads,
	type UntypedProperty,
	type UntypedReadCause,
	untypedPropertyOf,
} from "../helpers/untypedProperties"
import { forEachTypedChild, type TypedNode } from "../visitor/index"
import type { DeclarationOrder } from "./declarationOrder"

// The uses the order check refused, by the Position of the Namespace's name.
// Such a read is that Diagnostic's to report.
let refused = new Set<common.Position>()

export function forgetRefusedUses(): void {
	refused = new Set()
}

export function refuseUse(position: common.Position): void {
	refused.add(position)
}

type FailedRead = { position: common.Position; cause: UntypedReadCause }

// The reads of static Properties the enricher could not type, once the order
// check has run. One report per Property, at the Property where this Program
// declares it and at the first read otherwise. See "Static Properties while
// hoisting" in packages/compiler/src/enricher/DEVELOPMENT.md.
export function reportUntypedReads(order: DeclarationOrder): void {
	let program = order.program

	if (program === null || !anyFailedReads()) {
		return
	}

	let reads = new Map<UntypedProperty, Array<FailedRead>>()
	let visit = (node: TypedNode): void => {
		let read = failedRead(node)

		if (read !== null) {
			reads.set(read.property, [
				...(reads.get(read.property) ?? []),
				read.read,
			])
		}

		forEachTypedChild(node, visit)
	}

	visit(program)

	for (let [property, failed] of reads) {
		reportProperty(property, failed)
	}
}

// A read the enricher answered with an Error. One the order check refused is
// left out, and so is a read of a value with a mistake where it is written.
function failedRead(
	node: TypedNode,
): { property: UntypedProperty; read: FailedRead } | null {
	if (
		node.nodeType !== "Lookup" ||
		node.type.type !== "Error" ||
		node.base.nodeType !== "Identifier" ||
		node.base.type.type !== "Namespace" ||
		refused.has(node.base.position)
	) {
		return null
	}

	let property = untypedPropertyOf(node.base.type, node.member.content)
	let cause = property?.failures.get(node.member.position)

	if (
		property === undefined ||
		cause === undefined ||
		property.failsWhereWritten
	) {
		return null
	}

	return {
		property,
		read: { position: node.member.position, cause },
	}
}

function reportProperty(
	property: UntypedProperty,
	reads: Array<FailedRead>,
): void {
	let spelled = `${property.namespaceName}.${property.memberName}`
	let annotate = `Annotate '${spelled}' with its Type: 'static ${property.memberName}: Type = …'.`
	let [first, ...rest] = reads

	if (first.cause === "cycle") {
		reportError(
			`'${spelled}' is read before its Type is decided`,
			first.position,
			{
				code: "uninferable-property-type",
				labels: [
					primary(first.position, "its value can not be typed here"),
					...rest.map((read) =>
						secondary(read.position, "read here too"),
					),
				],
				notes: [
					"A static Property without an annotation takes its value's Type, and a Module of its import cycle may be checked before that value is.",
				],
				helps: [annotate],
			},
		)

		return
	}

	reportError(
		`'${spelled}' is read before its Type is decided`,
		property.name,
		{
			code: "uninferable-property-type",
			labels: [
				primary(
					property.name,
					"no annotation, so its value decides its Type",
				),
				...reads.map((read) =>
					secondary(
						read.position,
						"read where its value can not be typed",
					),
				),
			],
			notes: [
				"A static Property without an annotation takes its value's Type, so it can be read only where its value can be typed.",
			],
			helps: reads.every((read) => read.cause === "undeclared")
				? [
						annotate,
						"Or declare what its value reads above every read of it.",
					]
				: [annotate],
		},
	)
}
