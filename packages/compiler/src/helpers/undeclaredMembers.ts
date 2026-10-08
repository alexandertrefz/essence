import type { common } from "@essence-lang/interfaces"

// A member a Record Literal writes that the Type it stands for does not
// declare. `path` is dotted below the top level, as in `server.extra`.
export type UndeclaredMember = {
	path: string
	value: common.Position
}

// The members a Record Literal in Argument or payload position writes and its
// Type does not declare, walking into the Literals written as its members. A
// value that is not a Literal widens, and is not walked. See "Undeclared members"
// in DEVELOPMENT.md.
export function undeclaredMembers(
	expected: common.Type | common.GenericUse,
	value: common.typed.ExpressionNode | null | undefined,
	prefix = "",
): Array<UndeclaredMember> {
	if (value == null || value.nodeType !== "RecordValue") {
		return []
	}

	let shapes = declaringShapes(expected)

	if (shapes === null) {
		return []
	}

	let found: Array<UndeclaredMember> = []

	for (let [name, member] of Object.entries(value.members)) {
		let declaring = shapes.filter((shape) =>
			Object.hasOwn(shape.members, name),
		)

		if (declaring.length === 0) {
			found.push({ path: `${prefix}${name}`, value: member.position })
		} else if (declaring.length === 1) {
			found.push(
				...undeclaredMembers(
					declaring[0]!.members[name]!,
					member,
					`${prefix}${name}.`,
				),
			)
		}
	}

	return found
}

// The Records whose members a Literal may write. Null where any member goes,
// as under the empty Record, a Type Parameter or a Union of other Types.
function declaringShapes(
	type: common.Type | common.GenericUse,
): Array<common.RecordType> | null {
	while (type.type === "Refinement") {
		type = type.base
	}

	if (type.type === "Record") {
		return Object.keys(type.members).length === 0 ? null : [type]
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
