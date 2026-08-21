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
): string {
	return testIdentityKey({ modulePath, suitePath, name })
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
	// NOTE: The two the extension must bind. `essence.test.run` runs the ids;
	// `essence.test.debug` runs them under the debug adapter. Both take one
	// argument — see `TestLensArguments` — so a client binds two commands and
	// reads one shape.
	"essence.test.run" | "essence.test.debug"

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
): Array<TestLens> {
	let lenses: Array<TestLens> = []

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
				let id = identityKey(filePath, suitePath, name)

				gathered.push(id)
				lenses.push({
					position: node.keywordPosition,
					title: "Run",
					command: "essence.test.run",
					arguments: { ids: [id], filePath, title: name },
				})
				lenses.push({
					position: node.keywordPosition,
					title: "Debug",
					command: "essence.test.debug",
					arguments: { ids: [id], filePath, title: name },
				})

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
		}

		return gathered
	}

	walk(program.tests?.nodes ?? [], [])

	return lenses
}
