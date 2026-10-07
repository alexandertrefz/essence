import type { common, parser } from "@essence-lang/interfaces"

import { primary, reportError, secondary } from "../diagnostics/index"
import { countOf, describeType } from "../helpers/describe"
import { genericNamesMentioned, matchesType } from "../helpers/types"

// Refuses a default that makes two entries of one `overload` block accept the
// same call. See "Defaults in an Overload" in DEVELOPMENT.md.
export function refuseAmbiguousOverloadDefaults(
	entries: Array<{
		parameters: Array<parser.ParameterNode>
		position: common.Position
	}>,
	signatures: Array<{ parameterTypes: Array<common.Parameter> }>,
): void {
	// A block without a default has no such clash.
	if (
		entries.length < 2 ||
		!entries.some((entry) =>
			entry.parameters.some(
				(parameter) => parameter.defaultValue !== null,
			),
		)
	) {
		return
	}

	let shapes = entries.map((entry) => acceptedShapes(entry.parameters))
	// Which entries accept each shape, built once for the search.
	let entriesByShape = new Map<string, Array<number>>()

	for (let [index, entryShapes] of shapes.entries()) {
		for (let shape of entryShapes) {
			let accepting = entriesByShape.get(shape.key)

			if (accepting === undefined) {
				entriesByShape.set(shape.key, [index])
			} else if (accepting[accepting.length - 1] !== index) {
				accepting.push(index)
			}
		}
	}

	for (let [index, entryShapes] of shapes.entries()) {
		let clash: {
			omitted: parser.ParameterNode
			other: number
			shape: string
		} | null = null

		for (let shape of entryShapes) {
			if (shape.omitted.length === 0) {
				continue
			}

			let kept = keptParameters(
				signatures[index]!,
				entries[index]!,
				shape,
			)
			let other =
				entriesByShape.get(shape.key)?.find((accepting) => {
					let theirs = shapes[accepting]!.find(
						(candidate) => candidate.key === shape.key,
					)!

					return (
						accepting !== index &&
						typesOverlap(
							kept,
							keptParameters(
								signatures[accepting]!,
								entries[accepting]!,
								theirs,
							),
						)
					)
				}) ?? -1

			if (other !== -1) {
				clash = {
					omitted: shape.omitted[0]!,
					other,
					shape: shape.key,
				}

				break
			}
		}

		if (clash === null) {
			continue
		}

		let position = clash.omitted.defaultValue!.position

		reportError(
			"This default makes two Overloads accept the same call",
			position,
			{
				code: "ambiguous-overload-default",
				labels: [
					primary(
						position,
						`leaving this out ${describeAcceptedShape(clash.shape)}`,
					),
					secondary(
						entries[clash.other]!.position,
						`this entry ${describeAcceptedShape(clash.shape)}`,
					),
				],
				notes: [
					"An Overload is selected by the Arguments a call writes, so two entries that accept the same ones can not both be reached.",
				],
				helps: [
					"Delete the entry the default already stands for, or give the Parameters labels that tell the two apart.",
				],
			},
		)
	}
}

// Refuses a partial Record default that makes two entries of one shape
// accept one Argument list. See "Defaults in an Overload" in DEVELOPMENT.md.
export function refuseAmbiguousPartialDefaults(
	entries: Array<{
		parameters: Array<parser.ParameterNode>
		position: common.Position
	}>,
	signatures: Array<{ parameterTypes: Array<common.Parameter> }>,
): void {
	if (
		entries.length < 2 ||
		!signatures.some((signature) =>
			signature.parameterTypes.some(
				(parameter) => parameter.defaultMembers !== undefined,
			),
		)
	) {
		return
	}

	for (let [index, signature] of signatures.entries()) {
		for (let [other, against] of signatures.entries()) {
			if (other === index) {
				continue
			}

			let clash = partialDefaultClash(
				signature.parameterTypes,
				against.parameterTypes,
			)

			if (clash === null) {
				continue
			}

			let entry = entries[index]!
			let offset =
				signature.parameterTypes.length - entry.parameters.length
			let written = entry.parameters[clash.index - offset]
			let position = written?.defaultValue?.position ?? entry.position
			let parameter = signature.parameterTypes[clash.index]!

			reportError(
				"This default makes two Overloads accept the same Record",
				position,
				{
					code: "ambiguous-overload-default",
					labels: [
						primary(
							position,
							`a Record written without ${quotedMemberNames(parameter.defaultMembers ?? [])} still fits ${describeType(parameter.type)}`,
						),
						secondary(
							entries[other]!.position,
							`and fits this entry's ${describeType(against.parameterTypes[clash.index]!.type)}`,
						),
					],
					notes: [
						"An Overload is selected by the Arguments a call writes, so two entries that accept the same ones can not both be reached.",
					],
					helps: [
						"Give the two Parameters labels that tell them apart, or delete the entry the default already stands for.",
					],
				},
			)

			break
		}
	}
}

// The Parameter position where `left` takes a Record only through its
// default and `right` takes it too. Null where no Argument list fits both.
function partialDefaultClash(
	left: Array<common.Parameter>,
	right: Array<common.Parameter>,
): { index: number } | null {
	if (left.length !== right.length) {
		return null
	}

	let needsDefault: number | null = null

	for (let index = 0; index < left.length; index++) {
		if (left[index]!.name !== right[index]!.name) {
			return null
		}

		let overlap = parameterOverlap(left[index]!, right[index]!)

		if (overlap === null) {
			return null
		}

		if (overlap.leftNeedsDefault && needsDefault === null) {
			needsDefault = index
		}
	}

	return needsDefault === null ? null : { index: needsDefault }
}

// Whether one Argument answers both Parameters, and whether `left` needs its
// default for it. The Argument tried holds the members each side requires,
// since a partial Record admits only members it declares.
function parameterOverlap(
	left: common.Parameter,
	right: common.Parameter,
): { leftNeedsDefault: boolean } | null {
	if (left.type.type !== "Record" || right.type.type !== "Record") {
		// Any other pair overlaps where some value fits both.
		return matchesType(left.type, right.type) ||
			matchesType(right.type, left.type)
			? { leftNeedsDefault: false }
			: null
	}

	let leftMembers = left.type.members
	let rightMembers = right.type.members
	let candidate = new Set([
		...requiredRecordMembers(left),
		...requiredRecordMembers(right),
	])

	for (let member of candidate) {
		let inLeft = Object.hasOwn(leftMembers, member)
		let inRight = Object.hasOwn(rightMembers, member)

		// A member one side lacks while reading partially can not be
		// written, so there is no clash.
		if (
			(!inLeft && left.defaultMembers !== undefined) ||
			(!inRight && right.defaultMembers !== undefined)
		) {
			return null
		}

		if (
			inLeft &&
			inRight &&
			!matchesType(leftMembers[member]!, rightMembers[member]!) &&
			!matchesType(rightMembers[member]!, leftMembers[member]!)
		) {
			return null
		}
	}

	return {
		leftNeedsDefault:
			left.defaultMembers !== undefined &&
			candidate.size < Object.keys(leftMembers).length,
	}
}

// The members a call must write into a Record Argument: those the default
// does not fill in, or all of them without one.
function requiredRecordMembers(parameter: common.Parameter): Array<string> {
	let members = Object.keys((parameter.type as common.RecordType).members)

	if (parameter.defaultMembers === undefined) {
		return members
	}

	let filled = new Set(parameter.defaultMembers)

	return members.filter((member) => !filled.has(member))
}

// Members spelled as Diagnostics list them: `'host', 'retries'`.
function quotedMemberNames(names: ReadonlyArray<string>): string {
	return names.map((name) => `'${name}'`).join(", ")
}

// A signature with more defaults than this is not enumerated, since its
// shapes number `2 ** defaults`.
const MAXIMUM_ENUMERATED_DEFAULTS = 10

// The label sequences a signature accepts, each with the defaults it leaves
// out and the places of the Parameters it keeps.
type AcceptedShape = {
	key: string
	omitted: Array<parser.ParameterNode>
	kept: Array<number>
}

function acceptedShapes(
	parameters: Array<parser.ParameterNode>,
): Array<AcceptedShape> {
	let defaults = parameters.filter(
		(parameter) => parameter.defaultValue !== null,
	)

	if (
		defaults.length === 0 ||
		defaults.length > MAXIMUM_ENUMERATED_DEFAULTS
	) {
		return [
			{
				key: shapeKey(parameters),
				omitted: [],
				kept: parameters.map((_, place) => place),
			},
		]
	}

	let shapes: Array<AcceptedShape> = []

	for (let subset = 0; subset < 2 ** defaults.length; subset++) {
		let omitted = defaults.filter(
			(_, index) => (subset & (1 << index)) !== 0,
		)
		// A Set, since it is asked once per Parameter.
		let dropped = new Set(omitted)
		let kept = parameters.filter((parameter) => !dropped.has(parameter))

		shapes.push({
			key: shapeKey(kept),
			omitted,
			kept: kept.map((parameter) => parameters.indexOf(parameter)),
		})
	}

	return shapes
}

// The resolved Parameters a shape keeps. A Method's resolved signature starts
// with the receiver, so the written places are counted from the end.
function keptParameters(
	signature: { parameterTypes: Array<common.Parameter> },
	entry: { parameters: Array<parser.ParameterNode> },
	shape: AcceptedShape,
): Array<common.Parameter> {
	let offset = signature.parameterTypes.length - entry.parameters.length

	return shape.kept.map((place) => signature.parameterTypes[place + offset]!)
}

// Whether one Argument list fits both lists of Parameters, place by place.
// The labels agree already, so only the Types can tell two entries apart.
function typesOverlap(
	left: Array<common.Parameter>,
	right: Array<common.Parameter>,
): boolean {
	return left.every((parameter, place) => {
		let other = right[place]!

		return parameter.type.type === "Record" && other.type.type === "Record"
			? parameterOverlap(parameter, other) !== null
			: mayOverlap(parameter.type, other.type)
	})
}

// Whether some value may fit both Types. A Type Parameter may stand for
// anything, and a Union overlaps where one of its arms does.
function mayOverlap(left: common.Type, right: common.Type): boolean {
	if (
		genericNamesMentioned(left).size > 0 ||
		genericNamesMentioned(right).size > 0
	) {
		return true
	}

	if (left.type === "UnionType") {
		return left.types.some((arm) => mayOverlap(arm, right))
	}

	if (right.type === "UnionType") {
		return right.types.some((arm) => mayOverlap(left, arm))
	}

	return matchesType(left, right) || matchesType(right, left)
}

function shapeKey(parameters: Array<parser.ParameterNode>): string {
	return parameters
		.map((parameter) => parameter.externalName?.content ?? "_")
		.join(",")
}

function describeAcceptedShape(key: string): string {
	if (key === "") {
		return "takes no Arguments"
	}

	let labels = key.split(",")

	return `takes ${countOf(labels.length, "Argument")}, ${labels
		.map((label) => (label === "_" ? "one with no label" : `'${label}'`))
		.join(" then ")}`
}
