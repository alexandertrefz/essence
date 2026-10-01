import type { parser } from "@essence-lang/interfaces"

// One step of a binding's spine as the source wrote it: the member Identifier
// and its Type annotation, if any. Each step keeps its own span, so in
// `{ origin as { x, y } }` a rename of `origin` touches only `origin`.
export type PatternStep = {
	name: parser.IdentifierNode
	type: parser.TypeDeclarationNode | null
}

// One binding a Pattern makes. `path` runs from the value taken apart to this
// name: `{ origin as { x } }` gives `["origin", "x"]`, and a Pattern's own `as`
// binder gives `[]`.
export type PatternBinding = {
	name: parser.IdentifierNode
	path: Array<string>
	steps: Array<PatternStep>
	// The last step's annotation, or null for a bare member or a Pattern's
	// own `as` binder.
	type: parser.TypeDeclarationNode | null
	// The last step's member Identifier: what the Record calls it, where
	// `name` is what the binding is read under. They differ where `as` renamed
	// it, and the Language Server rewrites one without the other.
	member: parser.IdentifierNode | null
}

// Every name a Pattern brings into scope, in source order, at any depth. The
// Enricher, the Module linker and the Language Server all read this one list.
// A `name = literal` member constrains the value and binds nothing.
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

// Every name a Matcher introduces, in written order: a Pattern's bindings, or a
// Case Matcher's payload binder. Names only, without Types; the Enricher's
// `resolveMatcherBindings` knows what each stands for.
export function matcherNames(matcher: parser.MatcherNode): Array<string> {
	if (matcher.nodeType === "Pattern") {
		return patternBindings(matcher).map((binding) => binding.name.content)
	}

	if (matcher.nodeType !== "CaseMatcher" || matcher.binding === null) {
		return []
	}

	return matcher.binding.nodeType === "Pattern"
		? patternBindings(matcher.binding).map(
				(binding) => binding.name.content,
			)
		: [matcher.binding.content]
}

// The members constrained by a written value, at any depth, which let a Pattern
// decline a value. A Matcher arm may decline, but a Parameter or a Declaration
// has nowhere to fall through to. Each comes back with its path, since the
// position that refuses it still binds the name.
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
