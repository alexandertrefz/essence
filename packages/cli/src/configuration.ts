import { readFile } from "node:fs/promises"
import * as path from "node:path"

// NOTE: Essence has no project file, and this is deliberately not the moment to
// invent one. What a project needs to say about its tests today is one list —
// the tags a plain run leaves out — and every Essence project that is more than
// one file already has a `package.json`, because that is what installs the
// compiler. So the setting lives there, under an `essence` key that a later
// project file can adopt whole:
//
//     { "essence": { "test": { "skipTags": ["slow"] } } }
//
// NOTE: The NEAREST `package.json` that says something about Essence, walking
// up from the working directory — not simply the nearest `package.json`. In a
// workspace the closest one is usually a package that has nothing to say, and
// stopping at it would make the setting unreachable from exactly the
// directories a person runs tests in.

export type TestConfiguration = {
	skipTags: Array<string>
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
	test: { skipTags: [] },
	problems: [],
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readSkipTags(
	test: unknown,
	filePath: string,
	problems: Array<string>,
): Array<string> {
	if (!isRecord(test)) {
		problems.push(
			`${filePath}: "essence.test" is not an object, so no test ` +
				"settings were read from it.",
		)

		return []
	}

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
					test: { skipTags: [] },
					problems: [
						`${filePath}: "essence" is not an object, so no ` +
							"settings were read from it.",
					],
				}
			}

			let test =
				manifest.essence.test === undefined ? {} : manifest.essence.test

			return {
				filePath,
				test: { skipTags: readSkipTags(test, filePath, problems) },
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
