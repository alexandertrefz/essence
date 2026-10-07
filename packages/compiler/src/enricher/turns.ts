import type { parser } from "@essence-lang/interfaces"

import { firstRead } from "./waitingReads"

// One Program of a group, enriched a top-level Statement at a time.
export type ProgramTurns = {
	nodes: ReadonlyArray<parser.ImplementationNode>
	// Enriches one Statement into the Program's own collections.
	step: (node: parser.ImplementationNode) => void
	// Enriches what follows the Statements, such as the tests section.
	finish: () => void
}

// The names a Module of a cycle binds only once another Module's Statement
// declares them. See "Enriching a group in turns" in DEVELOPMENT.md.
export type LateNames = {
	// Runs once the hoist is over, before the first Statement is enriched.
	begin: () => void
	// The local names the Program at `index` may not read yet.
	waiting: (index: number) => ReadonlySet<string>
	// Binds the waiting names `node`, just enriched in the Program at `index`,
	// declares.
	rebind: (index: number, node: parser.ImplementationNode) => void
	// Gives up one waiting name once every unfinished Program waits. `reads`
	// holds each such Program's first read of a waiting name.
	refuse: (reads: ReadonlyMap<number, parser.IdentifierNode>) => void
	// Gives up every name still waiting once no Statement is left to bind one.
	settle: () => void
}

// Enriches each Program's Statements in their written order. A Statement
// reading a waiting name lets the other Programs go first. Without `late`
// each Program is enriched whole, one after another.
export function enrichInTurns(
	programs: ReadonlyArray<ProgramTurns>,
	late?: LateNames,
): void {
	let next = programs.map(() => 0)
	let finished = programs.map(() => false)

	late?.begin()

	for (;;) {
		let progressed = false

		for (let [index, program] of programs.entries()) {
			progressed = advance(program, index, next, late) || progressed

			if (
				!finished[index] &&
				next[index] === program.nodes.length &&
				(late === undefined || late.waiting(index).size === 0)
			) {
				program.finish()
				finished[index] = true
			}
		}

		if (
			programs.every(
				(program, index) => next[index] === program.nodes.length,
			)
		) {
			break
		}

		if (!progressed) {
			late!.refuse(stalledReads(programs, next, late!))
		}
	}

	late?.settle()

	for (let [index, program] of programs.entries()) {
		if (!finished[index]) {
			program.finish()
		}
	}
}

// Enriches the Program's Statements from `next[index]` on, up to the first
// that reads a waiting name. Answers whether it enriched any.
function advance(
	program: ProgramTurns,
	index: number,
	next: Array<number>,
	late: LateNames | undefined,
): boolean {
	let progressed = false

	while (next[index]! < program.nodes.length) {
		let node = program.nodes[next[index]!]!

		if (
			late !== undefined &&
			firstRead(node, late.waiting(index)) !== undefined
		) {
			break
		}

		program.step(node)
		next[index]! += 1
		progressed = true
		late?.rebind(index, node)
	}

	return progressed
}

// Each unfinished Program's first read of a name it waits for. Nothing has
// been bound since each of them stopped, so each has one.
function stalledReads(
	programs: ReadonlyArray<ProgramTurns>,
	next: Array<number>,
	late: LateNames,
): Map<number, parser.IdentifierNode> {
	let reads = new Map<number, parser.IdentifierNode>()

	for (let [index, program] of programs.entries()) {
		let node = program.nodes[next[index]!]
		let read =
			node === undefined
				? undefined
				: firstRead(node, late.waiting(index))

		if (read !== undefined) {
			reads.set(index, read)
		}
	}

	return reads
}
