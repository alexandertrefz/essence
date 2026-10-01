import { editDistance } from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

// What the tags of the whole workspace say about each other, which no single
// compile sees. `similar-tags` marks the rarer of two tags one typo apart,
// with a rename; `lonely-tag` marks a tag only one test carries.

// At most two edits apart, by the Compiler's own distance, where swapping two
// adjacent characters is one edit.
const MAXIMUM_DISTANCE = 2

// The tag's own span, so a rename edits the word and not the Modifier.
type TagSite = {
	tag: string
	filePath: string
	position: common.Position
}

type TagUsage = {
	tag: string
	// How many tests carry it, not how many places wrote it: a suite's tag counts
	// once per test under it.
	tests: number
	sites: Array<TagSite>
}

// Every tag each test of this Program carries, with where it was written. A
// test's tags include every enclosing suite's, as in the Enricher.
function tagSitesOf(
	filePath: string,
	program: parser.Program,
): Array<Array<TagSite>> {
	let tests: Array<Array<TagSite>> = []

	let modifierSites = (
		modifiers: Array<parser.TestModifierNode>,
	): Array<TagSite> =>
		modifiers.flatMap((modifier) =>
			modifier.name.content !== "tagged"
				? []
				: modifier.arguments.flatMap((argument) =>
						argument.nodeType === "Identifier"
							? [
									{
										tag: argument.content,
										filePath,
										position: argument.position,
									},
								]
							: [],
					),
		)

	let walk = (
		nodes: Array<parser.TestsNode>,
		covering: Array<TagSite>,
	): void => {
		for (let node of nodes) {
			if (node.nodeType === "Test") {
				tests.push([...covering, ...modifierSites(node.modifiers)])

				continue
			}

			if (node.nodeType === "Suite") {
				walk(node.nodes, [
					...covering,
					...modifierSites(node.modifiers),
				])
			}
		}
	}

	walk(program.tests?.nodes ?? [], [])

	return tests
}

// One usage per tag, over every file the workspace holds.
export function tagUsages(
	files: Array<{ filePath: string; program: parser.Program }>,
): Map<string, TagUsage> {
	let usages = new Map<string, TagUsage>()

	for (let file of files) {
		for (let sites of tagSitesOf(file.filePath, file.program)) {
			// Once per test, so `tagged slow, slow` does not make a lonely tag look used.
			let counted = new Set<string>()

			for (let site of sites) {
				let usage = usages.get(site.tag)

				if (usage === undefined) {
					usage = { tag: site.tag, tests: 0, sites: [] }
					usages.set(site.tag, usage)
				}

				if (!counted.has(site.tag)) {
					counted.add(site.tag)
					usage.tests += 1
				}

				if (
					!usage.sites.some(
						(each) =>
							each.filePath === site.filePath &&
							each.position.start.line ===
								site.position.start.line &&
							each.position.start.column ===
								site.position.start.column,
					)
				) {
					usage.sites.push(site)
				}
			}
		}
	}

	return usages
}

// Which of two similar tags is the mistake: the one fewer tests carry, else
// the one sorting later. The answer never depends on reading order.
function rarer(left: TagUsage, right: TagUsage): TagUsage {
	if (left.tests !== right.tests) {
		return left.tests < right.tests ? left : right
	}

	return left.tag > right.tag ? left : right
}

function similarTagsDiagnostic(
	site: TagSite,
	suggestion: string,
): common.Diagnostic {
	return {
		severity: "warning",
		message: `The tags '${site.tag}' and '${suggestion}' are nearly the same`,
		position: site.position,
		code: "similar-tags",
		labels: [
			{
				position: site.position,
				message: `'${suggestion}' is written elsewhere`,
				kind: "primary",
			},
		],
		notes: [
			"A run is narrowed by a tag spelled exactly, so two spellings of " +
				"one idea are two sets, and --tag answers with half of what " +
				"was meant.",
		],
		helps: [`Write '${suggestion}' here, or rename the other one.`],
		data: { kind: "suggestion", suggestion },
	}
}

function lonelyTagDiagnostic(site: TagSite): common.Diagnostic {
	return {
		severity: "information",
		message: `Only one test carries the tag '${site.tag}'`,
		position: site.position,
		code: "lonely-tag",
		labels: [
			{
				position: site.position,
				message: "no other test carries it",
				kind: "primary",
			},
		],
		notes: [
			"A tag names a set of tests to run or to leave out. A set of one " +
				"is a test that can be named by its own name.",
		],
		helps: [],
	}
}

// Every tag Diagnostic of the workspace by file. A file with none is absent,
// so the Server clears it.
export function tagDiagnostics(
	files: Array<{ filePath: string; program: parser.Program }>,
): Map<string, Array<common.Diagnostic>> {
	let usages = [...tagUsages(files).values()]
	let byFile = new Map<string, Array<common.Diagnostic>>()

	let add = (filePath: string, diagnostic: common.Diagnostic): void => {
		let existing = byFile.get(filePath)

		if (existing === undefined) {
			byFile.set(filePath, [diagnostic])
		} else {
			existing.push(diagnostic)
		}
	}

	// One report per pair, on the rarer side.
	for (let index = 0; index < usages.length; index += 1) {
		for (let other = index + 1; other < usages.length; other += 1) {
			let left = usages[index]!
			let right = usages[other]!

			if (editDistance(left.tag, right.tag) > MAXIMUM_DISTANCE) {
				continue
			}

			let mistake = rarer(left, right)
			let suggestion = mistake === left ? right.tag : left.tag

			for (let site of mistake.sites) {
				add(site.filePath, similarTagsDiagnostic(site, suggestion))
			}
		}
	}

	for (let usage of usages) {
		if (usage.tests !== 1) {
			continue
		}

		for (let site of usage.sites) {
			add(site.filePath, lonelyTagDiagnostic(site))
		}
	}

	return byFile
}
