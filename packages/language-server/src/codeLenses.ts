import {
	nameTemplate,
	testIdentityKey,
} from "@essence-lang/compiler/enricher/tests"
import type { common, parser } from "@essence-lang/interfaces"

// NOTE: An identity is spelled by the Enricher's own two functions rather than
// by a second reading of them here. The Language Server holds the PARSER's tree,
// where nothing has been enriched — but what a name TEMPLATE is and how the
// steps of an id are escaped are one answer, and two spellings of one identity
// is exactly the drift the structural identity exists to prevent.
function identityKey(
	modulePath: string,
	suitePath: Array<string>,
	name: string,
	row: number | null = null,
): string {
	return testIdentityKey({ modulePath, suitePath, name }, row)
}

// NOTE: Every id one written test stands for — one for an ordinary test, and
// one per ROW of a table test, because a row is a test in its own right and
// carries its row number as the last step of its identity. The rows are counted
// off the written List, which is the only reason a table test's rows have to be
// written where the test is.
function identitiesOf(
	node: parser.TestNode,
	modulePath: string,
	suitePath: Array<string>,
	name: string,
): Array<string> {
	let rows =
		node.table?.value.nodeType === "ListValue"
			? node.table.value.values.length
			: null

	if (rows === null) {
		return [identityKey(modulePath, suitePath, name)]
	}

	return Array.from({ length: rows }, (_unused, row) =>
		identityKey(modulePath, suitePath, name, row),
	)
}

// NOTE: The Run and Debug lenses above every `test` and every `suite`. The
// Server produces the lens and the COMMAND it carries; what the command does is
// the extension's, because running is an Editor gesture — a Test Explorer item,
// a terminal, a debug session — and the Server has no idea which of them the
// reader is looking at.
//
// NOTE: A lens sits on the KEYWORD's line, which is where the item begins and
// the only Position a reader can point at. A suite's lens runs everything under
// it: the ids of every test it holds, gathered here rather than expanded by the
// client, because the structural identity of a test is the Compiler's business
// and no client should be spelling one.

export type TestLensCommand =
	// NOTE: The three the extension must bind. `essence.test.run` runs the ids;
	// `essence.test.debug` runs them under the debug adapter;
	// `essence.test.acceptSnapshot` re-runs them and RECORDS whatever they
	// produce, which is `essence test --update` narrowed to what a reader is
	// looking at, and is offered only where a run left something to accept.
	// All three take one argument — see `TestLensArguments` — so a client binds
	// three commands and reads one shape.
	"essence.test.run" | "essence.test.debug" | "essence.test.acceptSnapshot"

export type TestLensArguments = {
	// NOTE: Structural ids, exactly as every event spells them. A suite carries
	// the ids of the tests under it; a test carries its own.
	ids: Array<string>
	// NOTE: The file the item was written in, so that a client which has no
	// results yet — nothing has run, so no id is known — can still run the file
	// and narrow afterwards.
	filePath: string
	// NOTE: What to call the run in a progress message.
	title: string
}

export type TestLens = {
	// NOTE: The keyword's own span. A client renders the lens on the line it
	// starts on.
	position: common.Position
	title: string
	command: TestLensCommand
	arguments: TestLensArguments
}

export function findTestLenses(
	program: parser.Program,
	filePath: string,
	// NOTE: The tests whose last run left a snapshot to accept — one nothing
	// had recorded, or one that differs. A lens to accept a snapshot is offered
	// only over those: an "Accept snapshot" above every test in the file would
	// be a button that usually does nothing.
	pendingSnapshots: ReadonlySet<string> = new Set(),
): Array<TestLens> {
	let lenses: Array<TestLens> = []
	let accepting = (ids: Array<string>): boolean =>
		ids.some((id) => pendingSnapshots.has(id))

	// NOTE: The ids under a node, gathered as the walk unwinds, so that a suite
	// carries what its tests carry and the walk is one pass.
	let walk = (
		nodes: Array<parser.TestsNode>,
		suitePath: Array<string>,
	): Array<string> => {
		let gathered: Array<string> = []

		for (let node of nodes) {
			if (node.nodeType === "Test") {
				let name = nameTemplate(node.name)
				let ids = identitiesOf(node, filePath, suitePath, name)

				gathered.push(...ids)
				lenses.push({
					position: node.keywordPosition,
					title: "Run",
					command: "essence.test.run",
					arguments: { ids, filePath, title: name },
				})
				lenses.push({
					position: node.keywordPosition,
					title: "Debug",
					command: "essence.test.debug",
					arguments: { ids, filePath, title: name },
				})

				if (accepting(ids)) {
					lenses.push({
						position: node.keywordPosition,
						title: "Accept snapshot",
						command: "essence.test.acceptSnapshot",
						arguments: { ids, filePath, title: name },
					})
				}

				continue
			}

			if (node.nodeType !== "Suite") {
				continue
			}

			let name = nameTemplate(node.name)
			let inside = walk(node.nodes, [...suitePath, name])

			gathered.push(...inside)

			// NOTE: A suite holding no test at all gets no lens: there would be
			// nothing for the command to run, and an Editor offering a button
			// that does nothing is worse than offering none.
			if (inside.length === 0) {
				continue
			}

			lenses.push({
				position: node.keywordPosition,
				title: "Run",
				command: "essence.test.run",
				arguments: { ids: inside, filePath, title: name },
			})
			lenses.push({
				position: node.keywordPosition,
				title: "Debug",
				command: "essence.test.debug",
				arguments: { ids: inside, filePath, title: name },
			})

			if (accepting(inside)) {
				lenses.push({
					position: node.keywordPosition,
					title: "Accept snapshot",
					command: "essence.test.acceptSnapshot",
					arguments: { ids: inside, filePath, title: name },
				})
			}
		}

		return gathered
	}

	walk(program.tests?.nodes ?? [], [])

	return lenses
}
