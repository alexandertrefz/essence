import { readFile } from "node:fs/promises"
import * as path from "node:path"

// NOTE: Essence has no project file, and this is deliberately not the moment to
// invent one. What a project needs to say about its tests today is two lists —
// the tags a plain run leaves out, and the directories a walk stays out of —
// and every Essence project that is more than one file already has a
// `package.json`, because that is what installs the compiler. So the settings
// live there, under an `essence` key that a later project file can adopt whole:
//
//     { "essence": { "test": {
//         "skipTags": ["slow"],
//         "exclude": ["fixtures/broken"]
//     } } }
//
// NOTE: The NEAREST `package.json` that says something about Essence, walking
// up from the working directory — not simply the nearest `package.json`. In a
// workspace the closest one is usually a package that has nothing to say, and
// stopping at it would make the setting unreachable from exactly the
// directories a person runs tests in.

export type TestConfiguration = {
	skipTags: Array<string>
	// NOTE: Absolute paths a discovery walk never descends into, resolved
	// against the manifest that named them. A file NAMED on the command line is
	// still compiled and still reported: what this excludes is the walk, which
	// is the half nobody asked for by name.
	exclude: Array<string>
}

export type ProjectConfiguration = {
	// NOTE: The file the settings were read from, for `--verbose` and for the
	// message that says a setting was ignored. Null when nothing said anything.
	filePath: string | null
	test: TestConfiguration
	// NOTE: What was written but could not be read as a setting. Reported as a
	// warning rather than refused: a project should not fail to run its tests
	// because a key it added is the wrong shape, and silence would leave the
	// author believing a filter is in force when it is not.
	problems: Array<string>
}

export const noConfiguration: ProjectConfiguration = {
	filePath: null,
	test: { skipTags: [], exclude: [] },
	problems: [],
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

// NOTE: Every project holds sources that are not the project's own tests — a
// directory of deliberately broken files, a corpus, an example a book quotes.
// They are named RELATIVE to the manifest, because that is where a reader
// thinks of them from, and answered as absolute paths, because that is what the
// walk compares.
function readExclusions(
	test: Record<string, unknown>,
	filePath: string,
	problems: Array<string>,
): Array<string> {
	let exclude = test.exclude

	if (exclude === undefined) {
		return []
	}

	if (
		!Array.isArray(exclude) ||
		exclude.some((each) => typeof each !== "string")
	) {
		problems.push(
			`${filePath}: "essence.test.exclude" is not a list of paths, so ` +
				"nothing is excluded from the walk.",
		)

		return []
	}

	let directory = path.dirname(filePath)

	return (exclude as Array<string>).map((each) =>
		path.resolve(directory, each),
	)
}

async function readManifest(filePath: string): Promise<unknown | undefined> {
	let contents: string

	try {
		contents = await readFile(filePath, "utf8")
	} catch {
		return undefined
	}

	try {
		return JSON.parse(contents)
	} catch {
		return undefined
	}
}

export async function readProjectConfiguration(
	from: string = process.cwd(),
): Promise<ProjectConfiguration> {
	let directory = path.resolve(from)

	while (true) {
		let filePath = path.join(directory, "package.json")
		let manifest = await readManifest(filePath)

		if (isRecord(manifest) && manifest.essence !== undefined) {
			let problems: Array<string> = []

			if (!isRecord(manifest.essence)) {
				return {
					filePath,
					test: { skipTags: [], exclude: [] },
					problems: [
						`${filePath}: "essence" is not an object, so no ` +
							"settings were read from it.",
					],
				}
			}

			let written =
				manifest.essence.test === undefined ? {} : manifest.essence.test

			if (!isRecord(written)) {
				return {
					filePath,
					test: { skipTags: [], exclude: [] },
					problems: [
						`${filePath}: "essence.test" is not an object, so no ` +
							"test settings were read from it.",
					],
				}
			}

			return {
				filePath,
				test: {
					skipTags: readSkipTags(written, filePath, problems),
					exclude: readExclusions(written, filePath, problems),
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
