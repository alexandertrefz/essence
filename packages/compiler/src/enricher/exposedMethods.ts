import type { common, enricher } from "@essence-lang/interfaces"

import { providedNamespaceAnswers } from "./providedBodies"
import { knownProtocol, solveConformance } from "./resolvers"

// The provided Methods an exported Namespace offers a JavaScript host, each
// as `Namespace.member(…)` would call it. See "Provided Methods" in
// packages/compiler/src/embed/DEVELOPMENT.md.
export function exposedMethods(
	namespace: common.NamespaceType,
	scope: enricher.Scope,
	position: common.Position,
): Array<common.ExposedMethod> {
	if (namespace.generics.length > 0 || namespace.targetType === null) {
		return []
	}

	let exposed: Array<common.ExposedMethod> = []

	for (let name of providedNames(namespace, scope)) {
		let answers = providedNamespaceAnswers(namespace, name, scope)
		let provided = answers.length === 1 ? answers[0]! : null

		if (provided === null || provided.type.type !== "SimpleMethod") {
			continue
		}

		let self = provided.type.generics.find(
			(generic) => generic.name === "Self",
		)

		if (self?.constraint === undefined || self.constraint === null) {
			continue
		}

		let solved = solveConformance(
			self.defaultType ?? namespace.targetType,
			self.constraint,
			scope,
			position,
			namespace.name,
		)

		if (!solved.ok) {
			continue
		}

		exposed.push({
			name,
			providedBy: provided.providedBy,
			type: {
				...provided.type,
				generics: provided.type.generics.filter(
					(generic) => generic !== self,
				),
			},
			conformance: {
				genericName: "Self",
				protocolName: self.constraint,
				source: solved.source,
			},
		})
	}

	return exposed
}

// The names the Namespace's Protocols provide and it does not declare. A name
// two Protocols provide, neither extending the other, is left out, since a
// call must pick one.
function providedNames(
	namespace: common.NamespaceType,
	scope: enricher.Scope,
): Array<string> {
	let writers = new Map<string, Set<string>>()

	for (let identity of namespace.conformsTo ?? []) {
		let provided = knownProtocol(identity, scope)?.providedMethods ?? {}

		for (let [name, writer] of Object.entries(provided)) {
			if (
				!Object.hasOwn(namespace.methods, name) &&
				!Object.hasOwn(namespace.properties, name)
			) {
				writers.set(name, (writers.get(name) ?? new Set()).add(writer))
			}
		}
	}

	return [...writers]
		.filter(([, written]) => {
			let answering = [...written].filter(
				(writer) =>
					![...written].some(
						(other) =>
							other !== writer &&
							knownProtocol(other, scope)?.conformsTo?.includes(
								writer,
							) === true,
					),
			)

			return answering.length === 1
		})
		.map(([name]) => name)
}
