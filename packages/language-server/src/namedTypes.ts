import { builtinTypes } from "@essence-lang/compiler/enricher/builtins"
import type { common } from "@essence-lang/interfaces"

import { contains } from "./positions"
import { typedProgramSections } from "./sections"

// NOTE: What a bare NAME names in the TYPE space where the cursor stands — the
// Language Server's mirror of the Enricher's `findTypeInScope`, which is the
// rail `Colour.cases()` and `Item.is(a, b)` compile through. A base that names
// a Type reads its members off a Namespace nobody declared, so there is no
// declaration to look them up on until the Type itself is known.
//
// NOTE: Read off the typed Program rather than probed for, which is what makes
// this necessary at all. A probe appends an invented member to the text and
// enriches it, and the Enricher answers this rail only for a member the
// fabricated Namespace OFFERS — so the invented name types the base as an
// Error, and a probe can only confirm a Type whose members are already known.
// That is the very question being asked here.
export function typeNamedAt(
	name: string,
	cursor: common.Cursor,
	program: common.typed.Program,
): common.Type | null {
	// NOTE: The innermost Scope that declares the name wins, exactly as it does
	// in the Enricher — a Type Parameter called `Colour` shadows the Choice of
	// that name for the length of the body it is declared on. Depth is what
	// says which of two answers stands further in, since the walk meets a
	// sibling Statement of an outer body AFTER the body it descended into.
	let found: { type: common.Type | null; depth: number } = {
		type: null,
		depth: -1,
	}

	function record(type: common.Type, depth: number) {
		if (depth > found.depth) {
			found.type = type
			found.depth = depth
		}
	}

	function readGenerics(
		generics: Array<common.typed.GenericDeclarationNode>,
		depth: number,
	) {
		for (let generic of generics) {
			if (generic.name !== name) {
				continue
			}

			// NOTE: An UNBOUNDED Type Parameter is recorded too. It offers
			// nothing — a Namespace is only fabricated for a bound — but it
			// still shadows an outer Choice of the same name, and answering
			// with that Choice's Cases would offer what the name does not
			// reach.
			record(
				generic.constraint === null
					? { type: "GenericUse", name }
					: {
							type: "GenericUse",
							name,
							constraint: generic.constraint,
						},
				depth,
			)
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

	// NOTE: Only a body the cursor STANDS IN is descended into: what the
	// Function beside this one declares is out of reach where the cursor is,
	// and a Type Parameter of it names nothing here.
	function visitNode(node: common.typed.ImplementationNode, depth: number) {
		switch (node.nodeType) {
			case "ChoiceDeclarationStatement":
			case "TypeAliasStatement":
				if (node.name.content === name) {
					record(node.type, depth)
				}

				return
			case "FunctionStatement":
				if (!contains(node.position, cursor)) {
					return
				}

				// NOTE: The Type Parameters stand in a Scope of their own
				// between the one the Function is declared in and its body —
				// which is what lets a Choice declared IN the body shadow a
				// Type Parameter of the same name.
				readGenerics(node.value.generics, depth + 1)
				visitBody(node.value.body, depth + 2)

				return
			case "NamespaceDefinitionStatement": {
				if (!contains(node.position, cursor)) {
					return
				}

				readGenerics(node.generics, depth + 1)

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

						readGenerics(method.value.generics, depth + 2)
						visitBody(method.value.body, depth + 3)
					}
				}

				return
			}
			case "IfStatement":
				if (contains(node.position, cursor)) {
					visitBody(node.body, depth + 1)
				}

				return
			case "IfElseStatement":
				if (contains(node.position, cursor)) {
					visitBody(node.trueBody, depth + 1)
					visitBody(node.falseBody, depth + 1)
				}

				return
			case "Match":
				if (contains(node.position, cursor)) {
					for (let handler of node.handlers) {
						visitBody(handler.body, depth + 1)
					}
				}

				return
			default:
				return
		}
	}

	// NOTE: The implementation, and every Section the cursor stands in — a
	// Section is a Scope, and the tests block is a CHILD of the implementation,
	// so what a file declares is in reach inside a test while what one test
	// declares is in reach nowhere else. Each Section further in counts as a
	// step deeper, which is what lets a test shadow the file it tests.
	//
	// NOTE: The bodies a STATEMENT opens, and no Expression — the same limit
	// `namespacePropertyDocumentation` and `collectNamespaceTypes` walk under.
	// The only declaration an Expression can hide is one written inside a
	// Function literal, and a literal's own BOUND is refused anyway: a bounded
	// Function carries hidden conformance Parameters that exist at a direct
	// invocation alone, so the Validator will not let one be stored or passed.
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

	// NOTE: The builtins are the outermost Scope, so they answer last and only
	// for a name the document declares nothing under — a Program writing its
	// own `choice Side` means that one.
	return found.type ?? builtinTypes()[name] ?? null
}
