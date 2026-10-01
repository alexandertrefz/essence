import {
	builtinProtocols,
	builtinTypes,
} from "@essence-lang/compiler/enricher/builtins"
import type { ImportedNames } from "@essence-lang/compiler/modules"
import type { common } from "@essence-lang/interfaces"

import { typedHandlerExpressions } from "./matchHandlerChildren"
import { contains, isAtOrBefore } from "./positions"
import { typedProgramSections } from "./sections"

// What a bare name names in the Type space at the cursor, mirroring the
// Enricher's `findTypeInScope`, as `Colour.cases()` needs. Read off the typed
// Program: a probe types such a base as an Error.
export function typeNamedAt(
	name: string,
	cursor: common.Cursor,
	program: common.typed.Program,
	// What the import block bound, for a Module. An imported Choice is declared
	// elsewhere, and a typed import entry carries the value where a name is both.
	imported: ImportedNames | null = null,
): common.Type | null {
	// The innermost declaring Scope wins, as in the Enricher. Depth says which
	// stands further in, since the walk meets an outer sibling after the body.
	let found: {
		type: common.Type | null
		depth: number
		bound: string | null
	} = {
		type: null,
		depth: -1,
		bound: null,
	}
	let visited = new WeakSet<object>()
	// A bound the Enricher typed carries its identity. An untyped one resolves to
	// the innermost Protocol of its name declared around it.
	let protocols: Array<{ type: common.ProtocolType; depth: number }> = []

	function record(type: common.Type, depth: number, bound: string | null) {
		if (depth > found.depth) {
			found.type = type
			found.depth = depth
			found.bound = bound
		}
	}

	// A typed Generic Declaration holds its bound as written, a GenericUse the
	// Protocol's identity. Only a Protocol declared further out reaches the bound.
	function boundIdentity(bound: string, depth: number): string {
		let innermost: { type: common.ProtocolType; depth: number } | null =
			null

		for (let declared of protocols) {
			if (
				declared.type.name === bound &&
				declared.depth < depth &&
				(innermost === null || declared.depth > innermost.depth)
			) {
				innermost = declared
			}
		}

		if (innermost !== null) {
			return innermost.type.identity
		}

		for (let outer of [imported?.protocols ?? {}, builtinProtocols()]) {
			if (Object.hasOwn(outer, bound)) {
				return outer[bound]!.identity
			}
		}

		return bound
	}

	function readGenerics(
		generics: Array<common.typed.GenericDeclarationNode>,
		typed: common.Type,
		depth: number,
	) {
		let resolved =
			typed.type === "Function" || typed.type === "Namespace"
				? typed.generics
				: []

		for (let generic of generics) {
			if (generic.name !== name) {
				continue
			}

			// An unbounded Type Parameter offers nothing, but still shadows an outer
			// Choice of its name.
			let answer = resolved.find((entry) => entry.name === name)

			if (answer === undefined) {
				record({ type: "GenericUse", name }, depth, generic.constraint)
			} else {
				record(
					answer.constraint == null
						? { type: "GenericUse", name }
						: {
								type: "GenericUse",
								name,
								constraint: answer.constraint,
							},
					depth,
					null,
				)
			}
		}
	}

	function visitBody(
		nodes: Array<common.typed.ImplementationNode>,
		depth: number,
	) {
		for (let node of nodes) {
			visitNode(node, depth)
		}
	}

	// Only a body the cursor stands in is descended into.
	function visitNode(node: common.typed.ImplementationNode, depth: number) {
		switch (node.nodeType) {
			case "ChoiceDeclarationStatement":
			case "TypeAliasStatement":
				if (node.name.content === name) {
					record(node.type, depth, null)
				}

				return
			case "ProtocolDeclarationStatement":
				protocols.push({ type: node.protocolType, depth })
				visitChildren(node, depth)

				return
			case "FunctionStatement":
				if (!contains(node.position, cursor)) {
					return
				}

				// The Type Parameters' Scope stands between the declaring Scope
				// and the body, so a Choice declared in the body shadows them.
				readGenerics(node.value.generics, node.type, depth + 1)
				visitBody(node.value.body, depth + 2)

				return
			case "NamespaceDefinitionStatement": {
				if (!contains(node.position, cursor)) {
					return
				}

				readGenerics(node.generics, node.type, depth + 1)

				for (let member of Object.values(node.methods)) {
					let methods =
						member.nodeType === "OverloadedMethod" ||
						member.nodeType === "OverloadedStaticMethod"
							? member.methods
							: [member.method]

					for (let method of methods) {
						if (!contains(method.position, cursor)) {
							continue
						}

						readGenerics(
							method.value.generics,
							method.type,
							depth + 2,
						)
						visitBody(method.value.body, depth + 3)
					}
				}

				return
			}
			case "IfStatement":
				if (contains(node.position, cursor)) {
					visitNode(node.condition, depth)
					visitBody(node.body, depth + 1)
				}

				return
			// Only the arm the cursor stands in. The `else` arm starts at its first
			// Statement, since a typed body holds no braces.
			case "IfElseStatement": {
				if (!contains(node.position, cursor)) {
					return
				}

				let first = node.falseBody[0]

				visitNode(node.condition, depth)
				visitBody(
					first !== undefined &&
						isAtOrBefore(first.position.start, cursor)
						? node.falseBody
						: node.trueBody,
					depth + 1,
				)

				return
			}
			// A Handler reaches from its Matcher to the next one's.
			case "Match": {
				if (!contains(node.position, cursor)) {
					return
				}

				visitNode(node.value, depth)

				let handler = node.handlers.findLast((candidate) =>
					isAtOrBefore(candidate.matcherPosition.start, cursor),
				)

				if (handler === undefined) {
					return
				}

				for (let expression of typedHandlerExpressions(handler)) {
					visitNode(expression, depth + 1)
				}

				visitBody(handler.body, depth + 1)

				return
			}
			// A Function literal is a Scope, the only one an Expression opens: its Type
			// Parameters and body are in reach only inside it.
			case "FunctionValue":
				if (!contains(node.position, cursor)) {
					return
				}

				readGenerics(node.value.generics, node.type, depth + 1)
				visitInside(node.value.parameters, depth + 1)
				visitBody(node.value.body, depth + 2)

				return
			default:
				visitChildren(node, depth)

				return
		}
	}

	// Every Expression a node holds, descended blindly, since a Function literal
	// may stand in any Expression position. Types are skipped: they hold no
	// Statement and are where the cycles are; `visited` guards the rest.
	function visitChildren(node: object, depth: number) {
		for (let [key, entry] of Object.entries(node)) {
			if (
				key !== "type" &&
				key !== "returnType" &&
				key !== "protocolType"
			) {
				visitInside(entry, depth)
			}
		}
	}

	function visitInside(value: unknown, depth: number) {
		if (value === null || typeof value !== "object" || visited.has(value)) {
			return
		}

		visited.add(value)

		if (Array.isArray(value)) {
			for (let entry of value) {
				visitInside(entry, depth)
			}

			return
		}

		if (
			typeof (value as Record<string, unknown>)["nodeType"] === "string"
		) {
			visitNode(value as common.typed.ImplementationNode, depth)

			return
		}

		visitChildren(value, depth)
	}

	// The implementation and every Section the cursor stands in, each a step
	// deeper, so a test shadows its file. Also the bodies Statements and Function
	// literals open, typed even where the Validator would refuse a bound literal.
	let depth = 0

	for (let section of typedProgramSections(program)) {
		if (
			section.kind !== "implementation" &&
			!contains(section.position, cursor)
		) {
			continue
		}

		visitBody([...section.head, ...section.nodes], depth)
		depth += 1
	}

	if (found.bound !== null) {
		return {
			type: "GenericUse",
			name,
			constraint: boundIdentity(found.bound, found.depth),
		}
	}

	// The import block answers after the file's own declarations and before the
	// builtins, as linking seeds the Scope.
	return found.type ?? imported?.types[name] ?? builtinTypes()[name] ?? null
}
