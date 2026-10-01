import type { common } from "@essence-lang/interfaces"

// The `= expression` defaults a Parameter list holds, in order: Expressions a
// Declaration owns outside its body. Every walk reaches them through here.
// Written over the field, since the parsed, typed and simplified Parameters all
// carry it.
export function parameterDefaults<ExpressionNode>(
	parameters: ReadonlyArray<{ defaultValue: ExpressionNode | null }>,
): Array<ExpressionNode> {
	return writtenDefaults(parameters)
}

// The `= { … }` defaults a Choice's Case list holds, in order. Named apart from
// `parameterDefaults` so a call site says which Declaration it walks.
export function caseDefaults<ExpressionNode>(
	cases: ReadonlyArray<{ defaultValue: ExpressionNode | null }>,
): Array<ExpressionNode> {
	return writtenDefaults(cases)
}

function writtenDefaults<ExpressionNode>(
	written: ReadonlyArray<{ defaultValue: ExpressionNode | null }>,
): Array<ExpressionNode> {
	let defaults: Array<ExpressionNode> = []

	for (let entry of written) {
		if (entry.defaultValue !== null) {
			defaults.push(entry.defaultValue)
		}
	}

	return defaults
}

// The members a Record Parameter's default fills in, sorted, as
// `Parameter.defaultMembers` carries them. Null for a Parameter with no default
// or a non-Record Type. See "Partial Record defaults" in DEVELOPMENT.md.
export function recordDefaultMembers(
	type: common.Type,
	defaultValue: {
		nodeType: string
		members?: Record<string, unknown>
	} | null,
): Array<string> | null {
	if (defaultValue === null || type.type !== "Record") {
		return null
	}

	let declared = Object.keys(type.members)

	let written = defaultValue.members

	if (defaultValue.nodeType !== "RecordValue" || written === undefined) {
		return declared.sort()
	}

	// Filtered through the declared members: an undeclared one is refused as
	// `default-type-mismatch`, and the answer stays a subset of the Type.
	return declared.filter((name) => Object.hasOwn(written, name)).sort()
}

// The value a written member holds. A typed member is its value and carries
// `nodeType`; a parsed member holds it in `value`.
function writtenMemberValue(
	member: unknown,
): { nodeType: string; members?: Record<string, unknown> } | null {
	if (typeof member !== "object" || member === null) {
		return null
	}

	let value =
		"nodeType" in member ? member : (member as { value?: unknown }).value

	if (typeof value !== "object" || value === null || !("nodeType" in value)) {
		return null
	}

	return value as { nodeType: string; members?: Record<string, unknown> }
}

// The members a Record default writes as Record Literals of their own,
// recursively: `Parameter.defaultNesting`, and the same for a Case payload's
// default. A caller may reach into these with a path key. See "Partial Record
// defaults" in DEVELOPMENT.md.
export function recordDefaultNesting(
	type: common.Type,
	defaultValue: {
		nodeType: string
		members?: Record<string, unknown>
	} | null,
): common.DefaultNesting | null {
	if (
		defaultValue === null ||
		type.type !== "Record" ||
		defaultValue.nodeType !== "RecordValue" ||
		defaultValue.members === undefined
	) {
		return null
	}

	let written = defaultValue.members
	// A null prototype, since a member may be called 'toString'.
	let nesting: Record<string, common.DefaultNesting> = Object.create(null)

	for (let [name, memberType] of Object.entries(type.members)) {
		if (memberType.type !== "Record" || !Object.hasOwn(written, name)) {
			continue
		}

		let value = writtenMemberValue(written[name])

		if (value === null || value.nodeType !== "RecordValue") {
			continue
		}

		let members = value.members ?? {}

		if (
			!Object.keys(memberType.members).every((member) =>
				Object.hasOwn(members, member),
			)
		) {
			continue
		}

		nesting[name] = recordDefaultNesting(memberType, value) ?? {}
	}

	return nesting
}

// The Argument list a call passes, with a hole where a Parameter took its
// default. `omittedParameterIndices` counts the `leading` receiver, and
// `trailing` holds the hidden conformance Arguments. A hole with nothing after
// it is not passed; any other is `hole()`, which fires a JavaScript default.
export function openArgumentHoles<Argument>(
	leading: ReadonlyArray<Argument>,
	written: ReadonlyArray<Argument>,
	omittedParameterIndices: ReadonlyArray<number>,
	trailing: ReadonlyArray<Argument>,
	hole: () => Argument,
): Array<Argument> {
	if (omittedParameterIndices.length === 0) {
		return [...leading, ...written, ...trailing]
	}

	let omitted = new Set(omittedParameterIndices)
	let total = leading.length + written.length + omitted.size
	let slots: Array<Argument | null> = []
	let next = 0

	for (let index = 0; index < total; index++) {
		if (index < leading.length) {
			slots.push(leading[index]!)
		} else if (omitted.has(index)) {
			slots.push(null)
		} else {
			slots.push(written[next++]!)
		}
	}

	if (trailing.length === 0) {
		while (slots.length > 0 && slots[slots.length - 1] === null) {
			slots.pop()
		}
	}

	return [...slots.map((slot) => slot ?? hole()), ...trailing]
}
