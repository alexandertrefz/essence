import type { common, parser } from "@essence-lang/interfaces"

// NOTE: What the tags of a whole workspace say about each other. Two questions,
// both of which can only be asked once every file has been read — which is why
// they are the Language Server's rather than the Compiler's: a compile sees one
// Module, and `tagged netwrok` is perfectly well-formed inside it.
//
// - `similar-tags`: two tags one typo apart. Reported on the RARER of the two,
//   because that is the one that is probably the mistake, and offered as a
//   rename to the common one.
// - `lonely-tag`: a tag exactly one test carries. Not wrong — a tag is a way to
//   name a set, and a set of one is a set — but it is what a tag that was meant
//   to catch on and did not looks like, and what a typo nothing is close enough
//   to look like.

// NOTE: Two edits, which is a typo. Three is a different word.
const MAXIMUM_DISTANCE = 2

// NOTE: The tag's own span, so a rename edits the word and not the Modifier.
export type TagSite = {
	tag: string
	filePath: string
	position: common.Position
}

export type TagUsage = {
	tag: string
	// NOTE: How many TESTS carry it, which is not how many places wrote it: a
	// `suite "…" tagged slow` holding four tests is one site and four tests,
	// and "used by exactly one test" is a claim about the tests.
	tests: number
	sites: Array<TagSite>
}

// NOTE: Every tag every test in this Program carries, with the place each one
// was written. A test's effective tags are its own plus every enclosing suite's
// — the same rule the Enricher applies — because a tag on a suite is a tag on
// what is under it.
export function tagSitesOf(
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

// NOTE: One usage per tag, over every file the workspace holds.
export function tagUsages(
	files: Array<{ filePath: string; program: parser.Program }>,
): Map<string, TagUsage> {
	let usages = new Map<string, TagUsage>()

	for (let file of files) {
		for (let sites of tagSitesOf(file.filePath, file.program)) {
			// NOTE: Deduplicated per TEST. A test writing `tagged slow, slow`
			// carries the tag once, and counting it twice would make a lonely
			// tag look used.
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

// NOTE: The Damerau-Levenshtein distance — Levenshtein plus the swap of two
// adjacent characters as one edit, because `slwo` for `slow` is the typo tags
// are most often written with and plain Levenshtein calls it two.
export function damerauLevenshtein(left: string, right: string): number {
	let rows = left.length + 1
	let columns = right.length + 1
	let distances: Array<Array<number>> = []

	for (let row = 0; row < rows; row += 1) {
		distances.push(
			Array.from({ length: columns }, (_, column) =>
				row === 0 ? column : column === 0 ? row : 0,
			),
		)
	}

	for (let row = 1; row < rows; row += 1) {
		for (let column = 1; column < columns; column += 1) {
			let cost = left[row - 1] === right[column - 1] ? 0 : 1
			let best = Math.min(
				distances[row - 1]![column]! + 1,
				distances[row]![column - 1]! + 1,
				distances[row - 1]![column - 1]! + cost,
			)

			if (
				row > 1 &&
				column > 1 &&
				left[row - 1] === right[column - 2] &&
				left[row - 2] === right[column - 1]
			) {
				best = Math.min(best, distances[row - 2]![column - 2]! + cost)
			}

			distances[row]![column] = best
		}
	}

	return distances[rows - 1]![columns - 1]!
}

// NOTE: Which of two similar tags is the mistake: the one fewer tests carry,
// and where they are carried by as many, the one that sorts later — so that the
// answer does not depend on the order the workspace happened to read its files
// in, and a reader who fixes one is not offered the reverse next time.
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

// NOTE: Every tag Diagnostic of the workspace, grouped by the file it belongs
// in. A file with nothing to say is not in the answer at all, which is what
// lets the Server clear a file it published for a moment ago.
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

	// NOTE: One report per PAIR, on the rarer side. Three tags within two edits
	// of each other report twice on whichever is rarest, which is right: it is
	// nearly the same as two different tags and the reader has to pick one.
	for (let index = 0; index < usages.length; index += 1) {
		for (let other = index + 1; other < usages.length; other += 1) {
			let left = usages[index]!
			let right = usages[other]!

			if (damerauLevenshtein(left.tag, right.tag) > MAXIMUM_DISTANCE) {
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
