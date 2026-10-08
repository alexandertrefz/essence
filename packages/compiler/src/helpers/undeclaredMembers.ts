import type { common } from "@essence-lang/interfaces"

// A member a Record Literal writes that the Type it stands for does not
// declare. `path` is dotted below the top level, as in `server.extra`, and
// `within` is the Record it was measured against.
export type UndeclaredMember = {
	path: string
	value: common.Position
	within: common.RecordType
}

// The members a Literal written where a Type is declared names beyond that
// Type. The walk reads into the Records, Lists, Dictionaries, Cases and
// `define` arms written inside it. A value that is not a Literal widens, and
// is not walked. See "Undeclared members" in DEVELOPMENT.md.
export function undeclaredMembers(
	expected: common.Type | common.GenericUse,
	value: common.typed.ExpressionNode | null | undefined,
	prefix = "",
): Array<UndeclaredMember> {
	let container = withoutRefinement(expected)

	switch (value?.nodeType) {
		case "RecordValue":
			return recordUndeclared(expected, value, prefix)
		case "ListValue":
			return container.type === "List"
				? value.values.flatMap((item) =>
						undeclaredMembers(container.itemType, item, prefix),
					)
				: []
		case "DictionaryValue":
			return container.type === "Dictionary"
				? value.entries.flatMap((entry) => [
						...undeclaredMembers(
							container.keyType,
							entry.key,
							prefix,
						),
						...undeclaredMembers(
							container.valueType,
							entry.value,
							prefix,
						),
					])
				: []
		case "CaseValue":
			return caseUndeclared(container, value, prefix)
		// A `define` answers with each arm's value, and each is held to the Type.
		case "Define":
			return [...value.arms, value.otherwise].flatMap((arm) =>
				undeclaredMembers(expected, arm.value, prefix),
			)
		default:
			return []
	}
}

// Whether a value is written as a Literal the walk reads into, or a `define`
// answering with one. A Case is measured where it is constructed.
export function isWrittenLiteral(value: { nodeType: string }): boolean {
	return (
		value.nodeType === "RecordValue" ||
		value.nodeType === "ListValue" ||
		value.nodeType === "DictionaryValue" ||
		value.nodeType === "Define"
	)
}

// Whether a Type holds a Record with members a walk could measure against,
// asked before an Argument is read for it, since reading it enriches.
export function declaresMembers(
	type: common.Type | common.GenericUse,
): boolean {
	let container = withoutRefinement(type)

	switch (container.type) {
		case "Record":
			return declaringShapes(container) !== null
		case "List":
			return declaresMembers(container.itemType)
		case "Dictionary":
			return (
				declaresMembers(container.keyType) ||
				declaresMembers(container.valueType)
			)
		case "UnionType":
			return container.types.some(declaresMembers)
		default:
			return false
	}
}

function recordUndeclared(
	expected: common.Type | common.GenericUse,
	value: common.typed.RecordValueNode,
	prefix: string,
): Array<UndeclaredMember> {
	let shapes = declaringShapes(expected)

	if (shapes === null) {
		return []
	}

	let found: Array<UndeclaredMember> = []
	let shorthand = isShorthandPayload(value)

	for (let [name, member] of Object.entries(value.members)) {
		let declaring = shapes.filter((shape) =>
			Object.hasOwn(shape.members, name),
		)

		if (declaring.length === 0) {
			found.push({
				path: `${prefix}${name}`,
				value: member.position,
				within: shapes[0]!,
			})

			continue
		}

		let memberTypes = declaring.map((shape) => shape.members[name]!)

		found.push(
			...undeclaredMembers(
				memberTypes.length === 1
					? memberTypes[0]!
					: { type: "UnionType", types: memberTypes },
				member,
				shorthand ? prefix : `${prefix}${name}.`,
			),
		)
	}

	return found
}

// A generic Case's payload, measured against the Case the position declares.
// A Case of a Choice with no Type Parameters already knows its members, so its
// own construction refuses what it does not declare.
function caseUndeclared(
	expected: common.Type | common.GenericUse,
	value: common.typed.CaseValueNode,
	prefix: string,
): Array<UndeclaredMember> {
	let arm = declaredCase(expected, value.caseName.content)

	if (
		arm === null ||
		value.type.type !== "Case" ||
		(value.type.choiceGenerics ?? []).length === 0
	) {
		return []
	}

	return undeclaredMembers(
		{ type: "Record", members: arm.members },
		value.value,
		prefix,
	)
}

function declaredCase(
	type: common.Type | common.GenericUse,
	name: string,
): common.CaseType | null {
	let container = withoutRefinement(type)

	if (container.type === "Case") {
		return container.name === name ? container : null
	}

	if (container.type !== "UnionType") {
		return null
	}

	for (let arm of container.types) {
		let found = declaredCase(arm, name)

		if (found !== null) {
			return found
		}
	}

	return null
}

// `#Value({ a = 1 })` wraps the value it was handed in the one-member Record
// its Case declares, at the value's own Position. The member is the Case's,
// so a path reads past it.
export function isShorthandPayload(
	value: common.typed.RecordValueNode,
): boolean {
	let members = Object.values(value.members)

	return members.length === 1 && members[0]!.position === value.position
}

function withoutRefinement(
	type: common.Type | common.GenericUse,
): common.Type | common.GenericUse {
	while (type.type === "Refinement") {
		type = type.base
	}

	return type
}

// The Records whose members a Literal may write. Null where any member goes,
// as under the empty Record, a Type Parameter or a Union of other Types. A
// Record that took in a written Union's wider arms answers all of them.
function declaringShapes(
	type: common.Type | common.GenericUse,
): Array<common.RecordType> | null {
	type = withoutRefinement(type)

	if (type.type === "Record") {
		let shapes = type.writtenArms ?? [type]

		return shapes.some((shape) => Object.keys(shape.members).length === 0)
			? null
			: shapes
	}

	if (type.type !== "UnionType") {
		return null
	}

	let shapes: Array<common.RecordType> = []

	for (let arm of type.types) {
		let armShapes = declaringShapes(arm)

		if (armShapes === null) {
			return null
		}

		shapes.push(...armShapes)
	}

	return shapes
}

// The Help that removes what a Literal names beyond its Type, and the data for
// its Quick Fix where one member is to go. A misspelled member, which another
// Help renames, is left to it.
export function removalEvidence(
	expected: common.Type | common.GenericUse,
	value: common.typed.ExpressionNode | null | undefined,
	misspelled: ReadonlyArray<string> = [],
): { helps: Array<string>; data: common.DiagnosticData | undefined } {
	let removed = undeclaredMembers(expected, value).filter(
		(member) => !misspelled.includes(member.path),
	)
	let names = removed.map((member) => `'${member.path}'`)

	if (names.length === 0) {
		return { helps: [], data: undefined }
	}

	return {
		helps: [
			names.length === 1
				? `Remove ${names[0]}.`
				: `Remove ${names.slice(0, -1).join(", ")} and ${names.at(-1)}.`,
		],
		data:
			removed.length === 1
				? {
						kind: "undeclared-member",
						member: removed[0]!.path.split(".").at(-1)!,
						value: removed[0]!.value,
					}
				: undefined,
	}
}
