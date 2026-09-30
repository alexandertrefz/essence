import {
	builtinProtocols,
	builtinTypes,
} from "@essence-lang/compiler/enricher/builtins"
import type { ImportedNames } from "@essence-lang/compiler/modules"
import type { common } from "@essence-lang/interfaces"

import { typedHandlerExpressions } from "./matchHandlerChildren"
import { contains, isAtOrBefore } from "./positions"
import { typedProgramSections } from "./sections"

// What a bare NAME names in the TYPE space where the cursor stands — the
// Language Server's mirror of the Enricher's `findTypeInScope`, which is the
// rail `Colour.cases()` and `Item.is(a, b)` compile through. A base that names
// a Type reads its members off a Namespace nobody declared, so there is no
// declaration to look them up on until the Type itself is known.
//
// Read off the typed Program rather than probed for, which is what makes
// this necessary at all. A probe appends an invented member to the text and
// enriches it, and the Enricher answers this rail only for a member the
// fabricated Namespace OFFERS — so the invented name types the base as an
// Error, and a probe can only confirm a Type whose members are already known.
// That is the very question being asked here.
export function typeNamedAt(
	name: string,
	cursor: common.Cursor,
	program: common.typed.Program,
	// What the document's import block bound, for a Module. An imported
	// Choice is declared in another file, so no Statement of this Program
	// declares it and the walk below can never answer for it — and the typed
	// import entries are no better: one carries the VALUE where a name came
	// across as both, which is the reading a probe already tried.
	imported: ImportedNames | null = null,
): common.Type | null {
	// The innermost Scope that declares the name wins, exactly as it does
	// in the Enricher — a Type Parameter called `Colour` shadows the Choice of
	// that name for the length of the body it is declared on. Depth is what
	// says which of two answers stands further in, since the walk meets a
	// sibling Statement of an outer body AFTER the body it descended into.
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
	// Where the Enricher typed a Declaration, its Type holds each bound's
	// identity and that answer is taken. A bound it left untyped is resolved to
	// the innermost Protocol of its name declared around it, once the walk has
	// met every Protocol on the way in.
	let protocols: Array<{ type: common.ProtocolType; depth: number }> = []

	function record(type: common.Type, depth: number, bound: string | null) {
		if (depth > found.depth) {
			found.type = type
			found.depth = depth
			found.bound = bound
		}
	}

	// A typed Generic Declaration holds its bound as written, and a
	// GenericUse holds the Protocol's identity, which is what the listings
	// read. A Type Parameter stands in a Scope of its own, so only a Protocol
	// declared further out than it reaches its bound.
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

			// An UNBOUNDED Type Parameter is recorded too. It offers
			// nothing — a Namespace is only fabricated for a bound — but it
			// still shadows an outer Choice of the same name, and answering
			// with that Choice's Cases would offer what the name does not
			// reach.
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

	// Only a body the cursor STANDS IN is descended into: what the
	// Function beside this one declares is out of reach where the cursor is,
	// and a Type Parameter of it names nothing here.
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

				// The Type Parameters stand in a Scope of their own
				// between the one the Function is declared in and its body —
				// which is what lets a Choice declared IN the body shadow a
				// Type Parameter of the same name.
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
			// Only the arm the cursor stands in, since what a sibling arm
			// declares is out of reach there. A typed body holds no braces, so
			// the `else` arm is the one from its first Statement on.
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
			// A Function LITERAL is a Scope like a declared one, and the
			// only one an Expression opens: its own Type Parameters, and
			// everything its body declares, are in reach inside it and nowhere
			// else. Read on the same terms `FunctionStatement` is, which is
			// what makes `<infer T is Equatable>(…) { <- T.` and the `choice`
			// written in a literal's body answer at all.
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

	// Every Expression a Node holds, whatever kind it is. The walk above
	// names the Nodes that open a Scope or declare a name; everything else is
	// descended into blindly, because a Function literal can be written in any
	// Expression position there is — an Argument, a Record member, a `define`
	// arm — and a list of the ones that can hold one is a list of every
	// Expression Node in the language, kept in step by hand.
	//
	// Types are stepped over: they are most of what a typed Program weighs,
	// they hold no Statement, and they are where its only cycles are. A
	// `visited` set stands behind them, because a Language Server that walks
	// into a cycle stops answering at all.
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

	// The implementation, and every Section the cursor stands in — a
	// Section is a Scope, and the tests block is a CHILD of the implementation,
	// so what a file declares is in reach inside a test while what one test
	// declares is in reach nowhere else. Each Section further in counts as a
	// step deeper, which is what lets a test shadow the file it tests.
	//
	// The bodies a Statement opens AND the ones an Expression does — a
	// Function literal is a Scope, and both its own Type Parameters and
	// whatever its body declares are in reach only inside it. A literal that
	// writes a BOUND can not be stored or passed, since a bounded Function
	// carries hidden conformance Parameters that exist at a direct invocation
	// alone — but the Validator is what says so, and a writer halfway through
	// one is asking this question of the Enricher's answer, which types the
	// literal and its Type Parameters like any other.
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

	// The import block stands between what the file declares and the
	// builtins, exactly as it does in the Scope linking seeds: a Choice this
	// file declares shadows one it imports, and an imported `Side` is the one
	// its own `Side` names.
	//
	// The builtins are the outermost Scope, so they answer last and only
	// for a name the document declares nothing under — a Program writing its
	// own `choice Side` means that one.
	return found.type ?? imported?.types[name] ?? builtinTypes()[name] ?? null
}
