import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

// NOTE: WHICH runtime modules import each other in a circle, written down. A
// cycle here is not an error — several of them are load-bearing, and the two
// groups below have been there since the numeric tower was built — but it is
// never a detail either: the bundler orders a chunk by the graph, so a cycle
// decides where a module's code lands and what can be shaken out of a Program
// that never calls into it. A new one moves bytes in every bundle, and a value
// read at module scope across a new edge is a `undefined is not a function` in
// a Program nobody changed.
//
// NOTE: So this is a LEDGER rather than a refusal. It asserts the exact set of
// mutually-importing groups, which means an edge that joins two of them, or
// opens a third, fails here and is read before it is merged rather than after.
// Adding to the ledger is allowed; doing it without saying why in the commit is
// not.
//
// NOTE: `import type` is NOT an edge. TypeScript erases a type-only import
// before the bundler ever sees it, so `Terminal` naming `RecordType` costs
// nothing and orders nothing — which is exactly the difference between the
// cycle this file would report and the one a reader counting `import` lines
// would. An import whose every specifier is written `type` is erased the same
// way and is left out for the same reason.
const runtimeDirectory = dirname(import.meta.dir)

// NOTE: A named import, a namespace import and a default one. The runtime
// writes only the first today; the other two are read all the same, because a
// reader adding one would otherwise add an edge this ledger could not see. The
// source is read as LINES rather than parsed: what is being checked is what the
// bundler is handed — the import statements at the top of each file — and a
// parser here would be a second answer to that question.
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

		// NOTE: `import { type RecordType, isRecord }` is an edge and
		// `import { type RecordType }` is not — the erasure is per specifier,
		// so the question is whether ANY of them survives it.
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

// NOTE: Tarjan's, which answers the groups rather than the paths: two modules
// are in one group exactly when each can reach the other, so a group IS the
// circle whatever route it is walked by. Listing paths instead would print
// thirty-four lines for these two groups and would change whenever an edge
// inside one of them moved, which is a ledger nobody could keep.
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
	// NOTE: TWO groups, and each is one idea. The numbers are one web because
	// every numeric Type answers a String and every String is read back as a
	// number: `Integer` formats through `String`, `String` parses through
	// `Integer`, `Rational` is built of Integers and prints like one, and
	// `keyEncoding` writes each of them into a Dictionary key. The other is the
	// universal comparison and the Record it compares: `Record.is` asks `anyIs`
	// about each member, and `anyIs` asks `Record.is` about a member that is a
	// Record.
	//
	// NOTE: `Terminal` is NOT in the second group, though `internalHelpers`
	// calls its renderer and `Record` does too. Terminal names `Record` for its
	// TYPE alone, which is erased, so the printer sits below both of them and
	// the bundle orders it there.
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

	// NOTE: The reading itself, on a source this file writes — because the test
	// above passes just as well when the reader finds nothing at all, and a
	// graph with no edges has no cycles in it.
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
