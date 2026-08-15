import type { common } from "@essence-lang/interfaces"

// NOTE: The Namespaces a Program DECLARES, and — separately — the ones it
// declares below its own top level. Two passes ask about them for two different
// reasons, and the difference between the two sets is the whole of what tells
// the standard library's own Namespaces from a Program's.
//
// NOTE: Asked ONCE per optimisation and handed to every pass that needs it —
// see `OptimiserPass.run` for why one answer serves the whole registry. The
// walk below reaches every object the Program holds, so this is a function to
// call once and read many times, not one to call where the answer is wanted.
//
// NOTE: A Program can not declare a top-level Namespace named after a builtin:
// `Integer` is already a name in that Scope, and the Enricher answers
// 'Variable 'Integer' is already declared'. A NESTED one is accepted — it
// declares the name in an inner Scope where nothing is taken — and it REPLACES
// the builtin for the rest of its block, in Method resolution as well as in
// conformance solving. So a Namespace named after a builtin is nested, always,
// and the standard library's own Namespaces — which reach the Optimiser inside
// the prelude's Programs — are top-level, always.

export type DeclaredNamespaces = {
	// NOTE: Every Namespace the Program declares, wherever it declares one.
	// `pool-constants` reads this: a declared Namespace is emitted as a `class`,
	// and a class is not hoisted, so a const band above it can not read one.
	all: ReadonlySet<string>
	// NOTE: The ones a block declares rather than the Program — the only ones
	// that can be standing in front of a builtin. `lower-scalar-operations`
	// reads this: `Integer` naming a Program's own Namespace is a Method the
	// Program wrote, and lowering it to a bigint comparison would answer for
	// code nobody wrote.
	nested: ReadonlySet<string>
}

export function declaredNamespaces(
	program: common.typedSimple.Program,
): DeclaredNamespaces {
	let all = new Set<string>()
	let nested = new Set<string>()

	// NOTE: Structural search rather than a walk of named positions, because
	// the question is "anywhere at all" and a Namespace may be declared in a
	// Function body, a Method body or a Match Handler's. A position added to
	// `typedSimple` later is searched without this having to hear about it.
	//
	// NOTE: The question is monotone — "collect every name" — so each object is
	// visited once, the way `typeWalkFinds` visits a Type: a Node's Types ride
	// along in the search, they are DAGs as they are actually held, and a
	// Choice's payload may name the Choice.
	let visited = new Set<object>()

	let visitNested = (value: unknown): void => {
		if (value === null || typeof value !== "object") {
			return
		}

		if (visited.has(value)) {
			return
		}

		visited.add(value)

		if (Array.isArray(value)) {
			for (let entry of value) {
				visitNested(entry)
			}

			return
		}

		let node = value as Record<string, unknown>

		if (node["nodeType"] === "NamespaceDefinitionStatement") {
			let name = node["name"] as Record<string, unknown> | undefined

			if (typeof name?.["name"] === "string") {
				all.add(name["name"])
				nested.add(name["name"])
			}
		}

		for (let entry of Object.values(node)) {
			visitNested(entry)
		}
	}

	for (let node of program.implementation.nodes) {
		if (node.nodeType === "NamespaceDefinitionStatement") {
			all.add(node.name.name)

			// NOTE: Its own name is the Program's, but what its members declare
			// is not: a Namespace declared inside a Method body is as nested as
			// one declared inside a Function.
			visitNested(node.properties)
			visitNested(node.methods)

			continue
		}

		visitNested(node)
	}

	return { all, nested }
}
