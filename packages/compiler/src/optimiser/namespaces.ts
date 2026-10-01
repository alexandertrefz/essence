import type { common } from "@essence-lang/interfaces"

// The Namespaces a Program declares, and those it declares below its top
// level. Asked once per optimisation, since it walks every object the Program
// holds. See "Namespaces named after builtins" in DEVELOPMENT.md.

export type DeclaredNamespaces = {
	// Every Namespace the Program declares, wherever it declares one.
	all: ReadonlySet<string>
	// The ones a block declares, the only ones that can shadow a builtin.
	nested: ReadonlySet<string>
}

export function declaredNamespaces(
	program: common.typedSimple.Program,
): DeclaredNamespaces {
	let all = new Set<string>()
	let nested = new Set<string>()

	// A structural search, since a Namespace may be declared in any body. Each
	// object is visited once, since Types are shared DAGs.
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

			// What its members declare is nested.
			visitNested(node.properties)
			visitNested(node.methods)

			continue
		}

		visitNested(node)
	}

	// Everything a tests section declares is nested.
	visitNested(program.tests)

	return { all, nested }
}
