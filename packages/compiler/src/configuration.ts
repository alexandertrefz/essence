import { readFileSync } from "node:fs"
import * as path from "node:path"

// NOTE: Essence has no project file, and this is deliberately not the moment to
// invent one. What a project needs to say about itself today is three lists and
// a flag — the directories that are not its sources, the tags an everyday run
// leaves out, and whether the declarations' own goals run — and every Essence
// project that is more than one file already has a `package.json`, because that
// is what installs the compiler. So the settings live there, under an `essence`
// key that a later project file can adopt whole:
//
//     { "essence": {
//         "exclude": ["fixtures/broken"],
//         "test": { "skipTags": ["slow"], "contracts": true }
//     } }
//
// NOTE: `exclude` sits at the top rather than under `test`, where it started,
// because it is not a statement about testing: it says which directories under
// a project are not the project's SOURCES — a corpus of deliberately broken
// files, a vendored copy, the build output of some other tool that happens to
// write `.es`. Every walk of a project asks that same question. The test walk
// asked it first, and then the Language Server grew a Problems panel that
// reports on the whole workspace rather than on the open tabs, and asked it
// second — against a project that had already answered, in a key nothing but
// the test runner read. A project says this once, and everything that walks it
// listens.
//
// NOTE: The NEAREST `package.json` that says something about Essence, walking
// up from the directory asked about — not simply the nearest `package.json`. In
// a workspace the closest one is usually a package that has nothing to say, and
// stopping at it would make the setting unreachable from exactly the
// directories a person runs tests in.
//
// NOTE: Read synchronously, because the two walks that need the answer are
// themselves synchronous — the Language Server's discovery walk runs inside a
// request — and one implementation that both can call is worth more than the
// asynchrony. It is a handful of small files, once, at the start of a run.

// NOTE: The directories a discovery walk never descends into, wherever the walk
// is written. `node_modules` is the one that matters: a walk that does not stop
// there spends all of its time in it, and nothing under it is a Module of THIS
// project. Held here, with the exclusions, because the Compiler's walk and the
// Language Server's walk have to agree about which files belong to a project —
// they used to hold a copy each, under comments promising the two lists were
// the same.
export const skippedDirectories = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	".claude",
])

export type TestConfiguration = {
	skipTags: Array<string>
	// NOTE: Whether every run of this project also tests what its declarations
	// promise — see `--contracts`. A project whose goals are worth running is a
	// project whose goals are worth running every time, and `--contracts` is
	// then the flag for asking about a project that did not say so. The two are
	// a union: either one turns the goals on.
	contracts: boolean
}

export type ProjectConfiguration = {
	// NOTE: The file the settings were read from, for `--verbose` and for the
	// message that says a setting was ignored. Null when nothing said anything.
	filePath: string | null
	// NOTE: Absolute paths a discovery walk never descends into, resolved
	// against the manifest that named them. A file NAMED on the command line is
	// still compiled and still reported, and a file OPENED in the editor still
	// gets its Diagnostics: what this excludes is the walk, which is the half
	// nobody asked for by name.
	exclude: Array<string>
	test: TestConfiguration
	// NOTE: What was written but could not be read as a setting. Reported as a
	// warning rather than refused: a project should not fail to run its tests
	// because a key it added is the wrong shape, and silence would leave the
	// author believing a filter is in force when it is not.
	problems: Array<string>
}

// NOTE: THE spelling of the defaults — the error returns below reuse it, so a
// field added to TestConfiguration is added in one place and can not default
// differently on the path that could not read the file.
function emptyTestConfiguration(): TestConfiguration {
	return { skipTags: [], contracts: false }
}

const noConfiguration: ProjectConfiguration = {
	filePath: null,
	exclude: [],
	test: emptyTestConfiguration(),
	problems: [],
}

// NOTE: Whether a path is one the project said to stay out of. Compared as a
// path rather than as text, so that `fixtures/broken` excludes everything under
// it and `fixtures/brokenish` beside it stays.
export function isExcludedPath(
	target: string,
	exclude: Array<string>,
): boolean {
	if (exclude.length === 0) {
		return false
	}

	let resolved = path.resolve(target)

	return exclude.some(
		(each) =>
			resolved === each || resolved.startsWith(`${each}${path.sep}`),
	)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readSkipTags(
	test: Record<string, unknown>,
	filePath: string,
	problems: Array<string>,
): Array<string> {
	let skipTags = test.skipTags

	if (skipTags === undefined) {
		return []
	}

	if (
		!Array.isArray(skipTags) ||
		skipTags.some((tag) => typeof tag !== "string")
	) {
		problems.push(
			`${filePath}: "essence.test.skipTags" is not a list of tag ` +
				"names, so no tag is skipped by default.",
		)

		return []
	}

	return skipTags as Array<string>
}

// NOTE: Every project holds sources that are not the project's own — a
// directory of deliberately broken files, a corpus, an example a book quotes.
// They are named RELATIVE to the manifest, because that is where a reader
// thinks of them from, and answered as absolute paths, because that is what a
// walk compares.
function readExclusions(
	essence: Record<string, unknown>,
	filePath: string,
	problems: Array<string>,
): Array<string> {
	let exclude = essence.exclude

	if (exclude === undefined) {
		return []
	}

	if (
		!Array.isArray(exclude) ||
		exclude.some((each) => typeof each !== "string")
	) {
		problems.push(
			`${filePath}: "essence.exclude" is not a list of paths, so ` +
				"nothing is excluded from the walk.",
		)

		return []
	}

	let directory = path.dirname(filePath)

	return (exclude as Array<string>).map((each) =>
		path.resolve(directory, each),
	)
}

// NOTE: The one setting here that is a plain yes or no. It is read the way the
// lists are — a shape nobody can use is a problem the run says out loud and
// then ignores, because a project should not fail to run its tests over a key
// it added wrongly, and silence would leave the author believing their goals
// are running when they are not.
function readContracts(
	test: Record<string, unknown>,
	filePath: string,
	problems: Array<string>,
): boolean {
	let contracts = test.contracts

	if (contracts === undefined) {
		return false
	}

	if (typeof contracts !== "boolean") {
		problems.push(
			`${filePath}: "essence.test.contracts" is not true or false, so ` +
				"the contract goals are left out.",
		)

		return false
	}

	return contracts
}

// NOTE: The one setting that moved. A project that still writes it under
// `test` is a project whose exclusions are silently not in force — and the
// symptom is a Problems panel full of a corpus it deliberately keeps broken,
// which reads as the editor being wrong rather than as a key being in the wrong
// place. So it is said out loud, and it says where the key went.
function reportMovedExclusions(
	test: Record<string, unknown>,
	filePath: string,
	problems: Array<string>,
): void {
	if (test.exclude === undefined) {
		return
	}

	problems.push(
		`${filePath}: "essence.test.exclude" has moved to ` +
			'"essence.exclude", which keeps the editor out of those ' +
			"directories as well as the test walk. Nothing was excluded.",
	)
}

function readManifest(filePath: string): unknown | undefined {
	let contents: string

	try {
		contents = readFileSync(filePath, "utf8")
	} catch {
		return undefined
	}

	try {
		return JSON.parse(contents)
	} catch {
		return undefined
	}
}

export function readProjectConfiguration(
	from: string = process.cwd(),
): ProjectConfiguration {
	let directory = path.resolve(from)

	while (true) {
		let filePath = path.join(directory, "package.json")
		let manifest = readManifest(filePath)

		if (isRecord(manifest) && manifest.essence !== undefined) {
			let problems: Array<string> = []

			if (!isRecord(manifest.essence)) {
				return {
					filePath,
					exclude: [],
					test: emptyTestConfiguration(),
					problems: [
						`${filePath}: "essence" is not an object, so no ` +
							"settings were read from it.",
					],
				}
			}

			let essence = manifest.essence
			let exclude = readExclusions(essence, filePath, problems)
			let written = essence.test === undefined ? {} : essence.test

			if (!isRecord(written)) {
				return {
					filePath,
					exclude,
					test: emptyTestConfiguration(),
					problems: [
						...problems,
						`${filePath}: "essence.test" is not an object, so no ` +
							"test settings were read from it.",
					],
				}
			}

			reportMovedExclusions(written, filePath, problems)

			return {
				filePath,
				exclude,
				test: {
					skipTags: readSkipTags(written, filePath, problems),
					contracts: readContracts(written, filePath, problems),
				},
				problems,
			}
		}

		let parent = path.dirname(directory)

		// NOTE: The filesystem root is its own parent — there is nothing above
		// it to look in, and comparing the two is how the walk knows it.
		if (parent === directory) {
			return noConfiguration
		}

		directory = parent
	}
}
