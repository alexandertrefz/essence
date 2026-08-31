import type { parser } from "@essence-lang/interfaces"

// NOTE: One binding a Pattern makes. `path` is the spine from the value being
// taken apart down to what this name stands for, so `{ origin as { x } }`
// gives `["origin", "x"]` and a Pattern's own `as` binder gives `[]` — the
// value itself. `type` is what the source wrote for the member, where it wrote
// anything: a bare `{ x }` leaves it null and takes its Type from the value.
// NOTE: One step of a binding's spine, as the source wrote it — the member
// Identifier and the Type annotation beside it, where there was one.
//
// Every step carries its own, not just the last: a nested Pattern's outer
// member is written once and stands on the spine of every binding beneath it,
// so `{ origin as { x, y } }` has a real `origin` to point a rename at and a
// real annotation to check. Giving an intermediate step the innermost binder's
// span instead made renaming `origin` overwrite `x` and `y`.
export type PatternStep = {
	name: parser.IdentifierNode
	type: parser.TypeDeclarationNode | null
}

export type PatternBinding = {
	name: parser.IdentifierNode
	path: Array<string>
	steps: Array<PatternStep>
	// NOTE: The LAST step's annotation — what the binding itself is declared
	// as. Null where the spine is empty, which is a Pattern's own `as` binder.
	type: parser.TypeDeclarationNode | null
	// NOTE: The LAST step's member Identifier, which is a DIFFERENT span from
	// `name` wherever `as` renamed it. Both are needed: what the binding is
	// read under is `name`, and what the Record calls it is this — and the
	// Language Server rewrites one without touching the other.
	member: parser.IdentifierNode | null
}

// NOTE: Every name a Pattern brings into scope, in source order, whatever the
// nesting. Four stages need exactly this list and must never disagree about
// it: the Enricher desugars one Constant per entry, the Module linker reports
// a Declaration per entry so a top-level Pattern can be exported, the Language
// Server declares a rename target per entry, and the Validator counts them to
// tell a Pattern that binds nothing from one that binds.
//
// A `name = literal` member contributes nothing — it constrains the value and
// the value is written right there, so there is no name to bring in.
export function patternBindings(
	pattern: parser.PatternNode,
	steps: Array<PatternStep> = [],
): Array<PatternBinding> {
	let bindings: Array<PatternBinding> = []
	let bind = (name: parser.IdentifierNode, spine: Array<PatternStep>) => {
		let last = spine[spine.length - 1]

		bindings.push({
			name,
			path: spine.map((step) => step.name.content),
			steps: spine,
			type: last?.type ?? null,
			member: last?.name ?? null,
		})
	}

	if (pattern.binder !== null) {
		bind(pattern.binder, steps)
	}

	for (let member of Object.values(pattern.members)) {
		if (member.kind === "Value") {
			continue
		}

		let spine = [...steps, { name: member.name, type: member.type }]

		if (member.binder === null) {
			bind(member.name, spine)

			continue
		}

		if (member.binder.nodeType === "Pattern") {
			bindings.push(...patternBindings(member.binder, spine))

			continue
		}

		bind(member.binder, spine)
	}

	return bindings
}

// NOTE: The members that make a Pattern able to DECLINE a value — a member
// constrained by a written value, at any depth. A Matcher may hold them,
// because an arm that declines falls through to the next one; a Parameter and
// a Declaration may not, because neither has anywhere to fall through to.
//
// A member constrained by TYPE is not among them: in an irrefutable position
// that is an annotation, and it fails the way every annotation fails.
//
// The spine comes back with each one, because the position that refuses a
// member still has to BIND its name — a body reading `width` after the
// Diagnostic about `{ width = 0 }` must not be told a second time that `width`
// does not exist.
export function refutablePatternMembers(
	pattern: parser.PatternNode,
	path: Array<string> = [],
): Array<{
	member: Extract<parser.PatternMemberNode, { kind: "Value" }>
	path: Array<string>
}> {
	let members: Array<{
		member: Extract<parser.PatternMemberNode, { kind: "Value" }>
		path: Array<string>
	}> = []

	for (let member of Object.values(pattern.members)) {
		let memberPath = [...path, member.name.content]

		if (member.kind === "Value") {
			members.push({ member, path: memberPath })

			continue
		}

		if (member.binder?.nodeType === "Pattern") {
			members.push(...refutablePatternMembers(member.binder, memberPath))
		}
	}

	return members
}
