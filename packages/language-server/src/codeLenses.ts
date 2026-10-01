import {
	nameTemplate,
	testIdentityKey,
} from "@essence-lang/compiler/enricher/tests"
import type { common, parser } from "@essence-lang/interfaces"

// Identities are spelled by the Enricher's own functions, so the lenses and
// the run never disagree about one.
function identityKey(
	modulePath: string,
	suitePath: Array<string>,
	name: string,
	row: number | null = null,
): string {
	return testIdentityKey({ modulePath, suitePath, name }, row)
}

// Every id one written test stands for: one, or one per row of a table test,
// counted off its written List.
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

// The Run and Debug lenses on the keyword line of every `test` and `suite`.
// The extension decides what a command does. A suite's lens carries the ids of
// every test under it, so no client has to spell an identity.

type TestLensCommand =
	// The commands the extension binds: `essence.test.run`,
	// `essence.test.debug`, and `essence.test.acceptSnapshot`, which re-runs the
	// tests recording snapshots. All take `TestLensArguments`.
	"essence.test.run" | "essence.test.debug" | "essence.test.acceptSnapshot"

type TestLensArguments = {
	// Structural ids, as events spell them; a suite's are its tests'.
	ids: Array<string>
	// The file the item was written in, so a client with no results can run it.
	filePath: string
	// What to call the run in a progress message.
	title: string
}

type TestLens = {
	// The keyword's span, whose line the lens sits on.
	position: common.Position
	title: string
	command: TestLensCommand
	arguments: TestLensArguments
}

export function findTestLenses(
	program: parser.Program,
	filePath: string,
	// The tests whose last run left a snapshot to accept. Only they get an
	// "Accept snapshot" lens.
	pendingSnapshots: ReadonlySet<string> = new Set(),
): Array<TestLens> {
	let lenses: Array<TestLens> = []
	let accepting = (ids: Array<string>): boolean =>
		ids.some((id) => pendingSnapshots.has(id))

	// The ids under a node, gathered as the walk unwinds.
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

			// A suite without tests gets no lens, since its command would do nothing.
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
