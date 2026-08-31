import type { common } from "@essence-lang/interfaces"

// NOTE: The `= expression` defaults a Parameter list holds, in order — the one
// enumeration of "the Expressions a Declaration owns that are not in its body".
// A default was wired into the Validator, the Optimiser's walk and nine
// Language Server walkers one `if (defaultValue !== null)` at a time, and each
// site that forgot was a silent hole rather than a failure; this is the shape
// that is added to a walk instead. Written over the field rather than over a
// Node type because the Parser's Parameter, the typed one and the simplified
// one all carry it and every walker reads exactly this much of it.
export function parameterDefaults<ExpressionNode>(
	parameters: ReadonlyArray<{ defaultValue: ExpressionNode | null }>,
): Array<ExpressionNode> {
	return writtenDefaults(parameters)
}

// NOTE: The `= { … }` defaults a Choice's Case list holds, in order — the
// second position an Expression stands in outside every body, and reached by
// the same shape rather than by another round of `if (defaultValue !== null)`
// per walker. Named apart from `parameterDefaults` so a call site says which
// Declaration it is walking, and sharing its implementation so the two can not
// come to answer differently.
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

// NOTE: The members a Record Parameter's default fills in — what
// `Parameter.defaultMembers` carries, and what `enrichParameterDefault` decides
// a partial default by. Null where the question does not arise: a Parameter
// with no default, or one whose Type is not a Record.
//
// NOTE: Read off what was WRITTEN and not off the default's Type, because a
// Parameter's Type is built by the resolver while a default is an expression
// only the enricher ever types — two passes, and the Type is what every call
// site is checked against. A Record LITERAL says in its own text which members
// it supplies, and may therefore supply only some of them; every OTHER
// expression is held to the Parameter's Type as it always was, so it supplies
// all of them. That is the same split the callee prologue makes for a different
// reason — a literal is evaluated member by member on demand, any other
// expression once per call — and the two agree on purpose.
//
// Sorted, so two structurally equal signatures carry equal member lists.
//
// NOTE: Written over the two fields it reads rather than over a Node type,
// because the Parser's Record Literal, the typed one and the simplified one all
// carry them — the Resolver asks this of the first, the Simplifier of the second
// and Hover of the second again, and one answer is what keeps a Type, an
// emission and a sentence from ever disagreeing about which members a call may
// leave out.
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

	// NOTE: Filtered through the declared members rather than read straight off
	// the literal — a literal that writes a member the Parameter's Type does not
	// declare is refused as `default-type-mismatch`, and until it is, what this
	// answers has to stay a subset of the Type it describes.
	return declared.filter((name) => Object.hasOwn(written, name)).sort()
}

// NOTE: The Record Literal a written member holds, whichever of the two shapes
// this walk was handed. A TYPED member IS its value and carries `nodeType`; a
// Parser member is a Node of its own that hangs its value off `value`. One
// discriminator, so the Resolver can ask this of the written AST and the
// Simplifier of the typed one and neither needs a walk of its own.
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

// NOTE: The members a Record default writes as a Record Literal of their own,
// and what THOSE write, recursively — `Parameter.defaultNesting`, and the same
// answer for a Case payload's default. A member listed here is one a caller may
// reach into with a path key: the callee rebuilds it member by member out of
// the Argument and the default, so `server.port = 1` merges where a whole
// `server = …` replaces.
//
// A member the default writes as anything ELSE is a value the callee takes or
// leaves whole. There is no way to take an expression apart without evaluating
// it — which is the very rule a non-literal default is hoisted by — so a path
// key into one would quietly replace the whole member, and it is refused
// instead.
//
// A nested literal has to write EVERY member its declared Type names, and one
// that does not is left out: only the TOP level of a default may be partial,
// so a nested one that falls short is a `default-type-mismatch` somebody has
// already been told about, and half a Record is not a Record to merge into.
//
// Read off what the default WRITES, over the same two fields and for the same
// reason `recordDefaultMembers` is.
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
	// NOTE: A null prototype, because these are the SOURCE's member names — a
	// member called 'toString' would otherwise be looked up on
	// Object.prototype.
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

// NOTE: The Argument list a call passes, with a hole where a Parameter took its
// default. `leading` is the receiver a Method Invocation passes first;
// `omittedParameterIndices` is indexed over the whole list, receiver included,
// which is the list the signature's Parameters line up with; `trailing` is the
// hidden conformance Arguments a bounded signature appends.
//
// A hole with NOTHING after it is simply not passed, which is what makes a call
// that omits a trailing default emit as the short call it reads as. A hole with
// something after it is passed as `hole()` — the target's own "no Argument
// given", which is precisely what fires a JavaScript default parameter.
//
// One walk for the three lists that need it: the Simplifier's, the emitted
// dispatch branch's — which the Simplifier can not build, because the branches
// share one written list and each takes its own defaults out of it — and the
// tests' expectations of both.
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
