import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

// Records which runtime modules import each other in a circle. The bundler
// orders a chunk by the graph, so a cycle decides where code lands and what a
// Program can shake out. A new edge can leave a value read at load undefined.
// A type-only import, or one whose every specifier is `type`, is erased before
// bundling and is no edge.
const runtimeDirectory = dirname(import.meta.dir)

// Named, namespace and default imports are all read, so no form adds an unseen
// edge. The source is read as lines, since its import statements are what the
// bundler is handed.
const importLine =
	/^import\s+(type\s+)?(\{[^}]*\}|\*\s+as\s+\w+|\w+(?:\s*,\s*\{[^}]*\})?)\s+from\s+"\.\/([\w.]+)"/gm

function valueImportsOf(source: string): Array<string> {
	let targets: Array<string> = []

	for (let match of source.matchAll(importLine)) {
		let [, typeKeyword, clause, target] = match

		if (typeKeyword !== undefined) {
			continue
		}

		let specifiers = (clause ?? "")
			.replace("{", "")
			.replace("}", "")
			.split(",")
			.map((specifier) => specifier.trim())
			.filter((specifier) => specifier.length > 0)

		// Erasure is per specifier, so an import is an edge when any specifier
		// survives it.
		if (specifiers.every((specifier) => specifier.startsWith("type "))) {
			continue
		}

		targets.push(target!)
	}

	return targets
}

function runtimeImportGraph(): Map<string, Array<string>> {
	let graph = new Map<string, Array<string>>()

	for (let name of readdirSync(runtimeDirectory).sort()) {
		if (!name.endsWith(".ts")) {
			continue
		}

		graph.set(
			name.slice(0, -".ts".length),
			valueImportsOf(readFileSync(join(runtimeDirectory, name), "utf8")),
		)
	}

	return graph
}

// Tarjan's algorithm, which answers groups rather than paths, so a group stays
// the same when an edge inside it moves.
function mutuallyImportingGroups(
	graph: Map<string, Array<string>>,
): Array<Array<string>> {
	let index = new Map<string, number>()
	let lowest = new Map<string, number>()
	let onStack = new Set<string>()
	let stack: Array<string> = []
	let groups: Array<Array<string>> = []
	let counter = 0

	let visit = (module: string): void => {
		index.set(module, counter)
		lowest.set(module, counter)
		counter += 1
		stack.push(module)
		onStack.add(module)

		for (let target of graph.get(module) ?? []) {
			if (!index.has(target)) {
				visit(target)
				lowest.set(
					module,
					Math.min(lowest.get(module)!, lowest.get(target)!),
				)
			} else if (onStack.has(target)) {
				lowest.set(
					module,
					Math.min(lowest.get(module)!, index.get(target)!),
				)
			}
		}

		if (lowest.get(module) !== index.get(module)) {
			return
		}

		let group: Array<string> = []

		for (;;) {
			let popped = stack.pop()!

			onStack.delete(popped)
			group.push(popped)

			if (popped === module) {
				break
			}
		}

		if (group.length > 1) {
			groups.push(group.sort())
		}
	}

	for (let module of [...graph.keys()].sort()) {
		if (!index.has(module)) {
			visit(module)
		}
	}

	return groups.sort((first, second) => first[0]!.localeCompare(second[0]!))
}

describe("the runtime's own import graph", () => {
	// The numbers form one web: `Integer` formats through `String`, `String`
	// parses through `Integer`, and `keyEncoding` encodes each. In the other,
	// `Record.is` and `anyIs` ask each other about members. `Terminal` imports
	// `Record` for its Type alone, so the bundle orders it before both.
	test("the mutually importing groups are the two that were always there", () => {
		expect(mutuallyImportingGroups(runtimeImportGraph())).toEqual([
			[
				"Algebraic",
				"Integer",
				"List",
				"Optional",
				"Rational",
				"String",
				"keyEncoding",
			],
			["Record", "internalHelpers"],
		])
	})

	// The ledger would pass on a reader that finds nothing, so the reader is
	// checked on a source written here.
	test("an import is read as an edge unless every specifier is erased", () => {
		expect(
			valueImportsOf(
				[
					'import type { RecordType } from "./Record"',
					'import { type ListType } from "./List"',
					'import { createString } from "./String"',
					'import { type RationalType, formatAsFraction } from "./Rational"',
					'import * as everything from "./type"',
					'import { kindOf } from "./registry"',
				].join("\n"),
			),
		).toEqual(["String", "Rational", "type", "registry"])
	})

	test("every module the runtime imports from is one of its own", () => {
		let graph = runtimeImportGraph()

		for (let [module, targets] of graph) {
			for (let target of targets) {
				expect({ module, target, known: graph.has(target) }).toEqual({
					module,
					target,
					known: true,
				})
			}
		}
	})
})
