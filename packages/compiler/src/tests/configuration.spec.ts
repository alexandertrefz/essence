import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import type { common } from "@essence-lang/interfaces"

import {
	createConfigurationCache,
	defaultConfiguration,
	essenceFilesUnder,
	findProjectFile,
	isExcludedPath,
	parseProjectConfiguration,
	PROJECT_FILE_NAME,
	projectSchema,
	readProjectConfiguration,
	settingEdits,
} from "../configuration"
import { optimiserPassNames } from "../optimiser"

async function withFiles<Value>(
	files: Record<string, string>,
	body: (directory: string) => Promise<Value> | Value,
): Promise<Value> {
	let directory = mkdtempSync(path.join(tmpdir(), "essence-configuration-"))

	try {
		for (let [fileName, source] of Object.entries(files)) {
			let filePath = path.join(directory, fileName)

			mkdirSync(path.dirname(filePath), { recursive: true })
			writeFileSync(filePath, source)
		}

		return await body(directory)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

// NOTE: Every Diagnostic of every file, flattened, because most tests ask
// about one problem and do not care which file's list it sat in.
function diagnosticsOf(configuration: {
	problems: Array<{ diagnostics: Array<common.Diagnostic> }>
}): Array<common.Diagnostic> {
	return configuration.problems.flatMap((problem) => problem.diagnostics)
}

function parse(text: string, directory = "/project") {
	return parseProjectConfiguration(
		text,
		path.join(directory, PROJECT_FILE_NAME),
	)
}

// #region Reading values

describe("essence.json — reading values", () => {
	it("reads every setting, with paths resolved against the file", () => {
		let configuration = parse(`{
			"$schema": "https://essencelang.org/schemas/essence.schema.json",
			"exclude": ["fixtures/broken", "../shared"],
			"test": {
				"skipTags": ["slow", "network"],
				"contracts": true,
				"cases": 250,
				"coverage": { "report": "lcov", "out": "reports/coverage" }
			},
			"build": {
				"out": "dist",
				"sourcemap": true,
				"minify": true,
				"embed": true,
				"optimise": false,
				"withoutOptimisations": ["pool-constants", "fold-constants"]
			}
		}`)

		expect(diagnosticsOf(configuration)).toEqual([])
		expect(configuration.filePath).toBe(
			path.resolve("/project", PROJECT_FILE_NAME),
		)
		expect(configuration.root).toBe(path.resolve("/project"))
		expect(configuration.exclude).toEqual([
			path.resolve("/project/fixtures/broken"),
			path.resolve("/shared"),
		])
		expect(configuration.test).toEqual({
			skipTags: ["slow", "network"],
			contracts: true,
			cases: 250,
			coverage: {
				report: "lcov",
				out: path.resolve("/project/reports/coverage"),
			},
		})
		expect(configuration.build).toEqual({
			out: path.resolve("/project/dist"),
			sourcemap: true,
			minify: true,
			embed: true,
			optimise: false,
			withoutOptimisations: ["pool-constants", "fold-constants"],
		})
	})

	it("allows comments and trailing commas", () => {
		let configuration = parse(`{
			// The corpus is broken on purpose.
			"exclude": ["fixtures/broken",],
			/* and the tests */
			"test": { "skipTags": ["slow",], },
		}`)

		expect(diagnosticsOf(configuration)).toEqual([])
		expect(configuration.exclude).toEqual([
			path.resolve("/project/fixtures/broken"),
		])
		expect(configuration.test.skipTags).toEqual(["slow"])
	})

	it("answers the defaults for an empty file, which still marks the root", () => {
		let configuration = parse("")
		let expected = defaultConfiguration()

		expect(configuration.root).toBe(path.resolve("/project"))
		expect(configuration.exclude).toEqual(expected.exclude)
		expect(configuration.test).toEqual(expected.test)
		expect(configuration.build).toEqual(expected.build)
		expect(configuration.problems).toEqual([])
	})

	it("answers the defaults for an empty object", () => {
		let configuration = parse("{}")

		expect(configuration.test).toEqual(defaultConfiguration().test)
		expect(configuration.problems).toEqual([])
	})
})

// #endregion

// #region Mistakes

describe("essence.json — mistakes are Warnings with a span", () => {
	it("reports a key it does not know, with the nearest one", () => {
		let configuration = parse(`{\n\t"test": { "skipTag": ["slow"] }\n}`)
		let [diagnostic] = diagnosticsOf(configuration)

		expect(configuration.test.skipTags).toEqual([])
		expect(diagnostic.code).toBe("unknown-setting")
		expect(diagnostic.severity).toBe("warning")
		expect(diagnostic.message).toBe('"test.skipTag" is not a setting')
		expect(diagnostic.position).toEqual({
			start: { line: 2, column: 12 },
			end: { line: 2, column: 21 },
		})
		expect(diagnostic.notes[0]).toContain('"skipTags"')
		expect(diagnostic.helps).toEqual(['Did you mean "skipTags"?'])
		expect(diagnostic.data).toEqual({
			kind: "suggestion",
			suggestion: "skipTags",
		})
	})

	it("lists the top-level settings for an unknown top-level key", () => {
		let [diagnostic] = diagnosticsOf(parse(`{ "excludes": [] }`))

		expect(diagnostic.code).toBe("unknown-setting")
		expect(diagnostic.notes[0]).toBe(
			'The settings at the top of essence.json are "$schema", "exclude", "test", "build".',
		)
		expect(diagnostic.helps).toEqual(['Did you mean "exclude"?'])
	})

	// NOTE: `"exclusions"` is three edits from `"exclude"` — past the near-miss
	// rule, and rightly so — and the whole report was two Notes and nothing to
	// do about them. The key reads as nothing, and taking it out is the edit.
	it("says what to do with a key that resembles nothing", () => {
		for (let written of [
			'{ "exclusions": ["build"] }',
			'{ "zzqqxx": 1 }',
		]) {
			let [diagnostic] = diagnosticsOf(parse(written))

			expect(diagnostic.code).toBe("unknown-setting")
			expect(diagnostic.helps).toEqual([
				"Remove the key, or write one of the settings above.",
			])
		}
	})

	// NOTE: `"test.cases": 200` — a setting written FLAT, the way a flag or a
	// dotted property spells one. The catalogue is a tree, so the key names a
	// real setting and names it whole; what is missing is the object around it.
	it("nests a setting written as a dotted key", () => {
		let [diagnostic] = diagnosticsOf(parse(`{\n\t"test.cases": 200\n}`))

		expect(diagnostic.code).toBe("unknown-setting")
		expect(diagnostic.helps).toEqual([
			'Write it nested: "test": { "cases": 200 }.',
		])
		expect(
			parse(`{\n\t"test": {\n\t\t"cases": 200\n\t}\n}`).test.cases,
		).toBe(200)
	})

	// NOTE: A dotted key whose parts name nothing is an unknown key like any
	// other, and is answered as one.
	it("leaves a dotted key that names no setting to the ordinary answer", () => {
		expect(diagnosticsOf(parse(`{ "test.nope": 1 }`))[0].helps).toEqual([
			"Remove the key, or write one of the settings above.",
		])
	})

	// NOTE: The example in the catalogue is the CATALOGUE's, never the author's,
	// and printing it as the answer said something the file did not:
	// `"minify": "false"` was answered `Write it as true or false: true`, which
	// turns minification ON, and `"cases": "50"` was answered `200`.
	it("writes the author's own value back in the shape the setting takes", () => {
		let coercions: Array<[string, string]> = [
			['{ "build": { "minify": "false" } }', "true or false: false"],
			['{ "build": { "minify": 0 } }', "true or false: false"],
			['{ "build": { "minify": 1 } }', "true or false: true"],
			['{ "test": { "cases": "50" } }', "at least 1: 50"],
			['{ "test": { "skipTags": "wip" } }', 'tag names: ["wip"]'],
			['{ "exclude": "fixtures" }', 'paths: ["fixtures"]'],
		]

		for (let [written, ending] of coercions) {
			let [diagnostic] = diagnosticsOf(parse(written))

			expect(diagnostic.helps[0]?.endsWith(ending)).toBe(true)
		}
	})

	// NOTE: And where the written value says nothing about what was meant, the
	// catalogue's example is offered AS an example rather than as the answer.
	it("offers the catalogue's value as an example where nothing coerces", () => {
		expect(
			diagnosticsOf(parse(`{ "test": { "cases": "many" } }`))[0].helps,
		).toEqual(["Write it as a whole number of at least 1 — '200', say."])
	})

	it("reports a setting of the wrong shape and falls back", () => {
		let configuration = parse(`{ "test": { "skipTags": "slow" } }`)
		let [diagnostic] = diagnosticsOf(configuration)

		expect(configuration.test.skipTags).toEqual([])
		expect(diagnostic.code).toBe("setting-shape")
		expect(diagnostic.message).toBe(
			'"test.skipTags" is not a list of tag names',
		)
		expect(diagnostic.labels[0]?.message).toBe("written as a String")
		expect(diagnostic.notes).toEqual(["No tag is skipped by default."])
		expect(diagnostic.helps).toEqual([
			'Write it as a list of tag names: ["slow"]',
		])
	})

	// NOTE: An empty String is not a list of one. `"skipTags": ""` says nothing
	// is to be skipped, and `[""]` is a tag no test can carry — a Help that
	// offered it was asking the author to write down a rule that matches
	// nothing and then accepting it in silence.
	it("offers the example rather than a list holding an empty name", () => {
		let configuration = parse(`{ "test": { "skipTags": "" } }`)
		let [diagnostic] = diagnosticsOf(configuration)

		expect(configuration.test.skipTags).toEqual([])
		expect(diagnostic.helps).toEqual([
			"Write it as a list of tag names — '[\"slow\"]', say.",
		])
	})

	// NOTE: And a number too big to read back is not the number that was
	// written. `Number` rounds past 2^53, so the Help offered a value nobody
	// had typed — and its Quick Fix would have written it into the file.
	it("offers the example rather than a number it rounded", () => {
		let configuration = parse(
			`{ "test": { "cases": "99999999999999999999" } }`,
		)
		let [diagnostic] = diagnosticsOf(configuration)

		expect(configuration.test.cases).toBeNull()
		expect(diagnostic.helps).toEqual([
			"Write it as a whole number of at least 1 — '200', say.",
		])
	})

	it("reports a Boolean written as a String", () => {
		let configuration = parse(`{ "test": { "contracts": "yes" } }`)
		let [diagnostic] = diagnosticsOf(configuration)

		expect(configuration.test.contracts).toBe(false)
		expect(diagnostic.code).toBe("setting-shape")
		expect(diagnostic.message).toBe('"test.contracts" is not true or false')
		expect(diagnostic.notes).toEqual(["The contract goals are left out."])
	})

	it("refuses a case count that is not a whole number of at least 1", () => {
		for (let written of ["0", "-3", "2.5", '"many"']) {
			let configuration = parse(`{ "test": { "cases": ${written} } }`)
			let [diagnostic] = diagnosticsOf(configuration)

			expect(configuration.test.cases).toBeNull()
			expect(diagnostic.code).toBe("setting-shape")
			expect(diagnostic.message).toBe(
				'"test.cases" is not a whole number of at least 1',
			)
		}

		expect(parse(`{ "test": { "cases": 1 } }`).test.cases).toBe(1)
	})

	it("refuses a coverage report format nobody writes, with the nearest", () => {
		let configuration = parse(
			`{ "test": { "coverage": { "report": "lcof" } } }`,
		)
		let [diagnostic] = diagnosticsOf(configuration)

		expect(configuration.test.coverage.report).toBeNull()
		expect(diagnostic.code).toBe("setting-shape")
		expect(diagnostic.message).toBe(
			'"test.coverage.report" is not "lcov" or "json"',
		)
		expect(diagnostic.helps).toEqual(['Did you mean "lcov"?'])
	})

	it("reports a table written as something else", () => {
		let configuration = parse(`{ "test": true, "build": [] }`)
		let diagnostics = diagnosticsOf(configuration)

		expect(diagnostics.map((each) => each.message)).toEqual([
			'"test" is not an object',
			'"build" is not an object',
		])
		expect(configuration.test).toEqual(defaultConfiguration().test)
		expect(configuration.build).toEqual(defaultConfiguration().build)
	})

	// NOTE: One bad item must not drop the whole list — a project with no
	// exclusions in force over one typo is the failure the file exists to
	// prevent.
	it("leaves out one wrong item of a list and keeps the rest", () => {
		let configuration = parse(
			`{ "exclude": ["broken", 3, "vendor"], "test": { "skipTags": ["slow", null] } }`,
		)
		let diagnostics = diagnosticsOf(configuration)

		expect(configuration.exclude).toEqual([
			path.resolve("/project/broken"),
			path.resolve("/project/vendor"),
		])
		expect(configuration.test.skipTags).toEqual(["slow"])
		expect(diagnostics.map((each) => each.message)).toEqual([
			'"exclude" holds something that is not one of its paths',
			'"test.skipTags" holds something that is not one of its tag names',
		])
		expect(diagnostics[0]?.labels[0]?.message).toBe("written as a number")
		expect(diagnostics[1]?.labels[0]?.message).toBe("written as null")
	})

	it("checks Optimiser pass names against the registry", () => {
		let configuration = parse(
			`{ "build": { "withoutOptimisations": ["pool-constant", "inline-loops"] } }`,
		)
		let [diagnostic] = diagnosticsOf(configuration)

		expect(configuration.build.withoutOptimisations).toEqual([
			"inline-loops",
		])
		expect(diagnostic.code).toBe("setting-shape")
		expect(diagnostic.message).toBe(
			'"pool-constant" is not an Optimiser pass',
		)
		expect(diagnostic.helps).toEqual(['Did you mean "pool-constants"?'])
		expect(diagnostic.notes[1]).toContain(optimiserPassNames.join(", "))
	})

	// NOTE: The key moved out of "test" when the editor grew a Problems panel
	// that speaks for the whole workspace and needed the same answer. A project
	// still writing it in the old place has no exclusions in force at all.
	it("says where test.exclude went", () => {
		let configuration = parse(`{ "test": { "exclude": ["broken"] } }`)
		let [diagnostic] = diagnosticsOf(configuration)

		expect(configuration.exclude).toEqual([])
		expect(diagnostic.code).toBe("moved-setting")
		expect(diagnostic.message).toBe('"test.exclude" has moved to "exclude"')
		expect(diagnostic.helps).toEqual(['Move it: "exclude": ["broken"]'])
	})

	it("reports a file that does not parse at the place it stopped, and reads nothing", () => {
		let configuration = parse(`{\n\t"exclude": ["broken"],\n\t"test": {\n}`)
		let [diagnostic] = diagnosticsOf(configuration)

		expect(configuration.exclude).toEqual([])
		expect(diagnostic.code).toBe("unreadable-project-file")
		expect(diagnostic.severity).toBe("warning")
		expect(diagnostic.message).toBe(
			"essence.json could not be read as JSON",
		)
		expect(diagnostic.position?.start.line).toBe(4)
		expect(diagnostic.labels[0]?.message).toBe("a '}' was expected here")
		// NOTE: The rule is a Note and the EDIT is the Help. "The file is JSON
		// with comments allowed" used to be the Help, and it is not an edit
		// anybody makes — jsonc already says which Token it wanted, which is.
		expect(diagnostic.notes).toEqual([
			"Every setting is at its default until the file reads.",
			"The file is JSON with comments and trailing commas allowed, as tsconfig.json is.",
		])
		expect(diagnostic.helps).toEqual([
			"Write the '}' that closes the object.",
		])
	})

	// NOTE: And the edit is offered for the FIRST refusal alone. jsonc recovers
	// generously and goes on reporting about text it has lost track of:
	// `{ test: 1 }` is one unquoted key, and the third report asked the reader
	// to "write the value the key holds" at the `}`, with the value written two
	// characters to its left. Every report keeps its label and its Notes.
	it("offers the edit for the first refusal alone", () => {
		let configuration = parse(`{ test: 1 }`)
		let diagnostics = diagnosticsOf(configuration)

		expect(
			diagnostics.map((diagnostic) => [
				diagnostic.labels[0]?.message,
				diagnostic.helps,
			]),
		).toEqual([
			["this is not JSON", []],
			["a quoted key was expected here", []],
			["a value was expected here", []],
		])
	})

	it("reports a file whose top level is not an object", () => {
		let [diagnostic] = diagnosticsOf(parse(`["broken"]`))

		expect(diagnostic.code).toBe("setting-shape")
		expect(diagnostic.message).toBe('"essence.json" is not an object')
	})

	it("carries the file and its text with the problems, for a renderer", () => {
		let configuration = parse(`{ "nope": 1 }`)

		expect(configuration.problems).toHaveLength(1)
		expect(configuration.problems[0].filePath).toBe(
			path.resolve("/project", PROJECT_FILE_NAME),
		)
		expect(configuration.problems[0].sourceText).toBe(`{ "nope": 1 }`)
	})
})

// #endregion

// #region Editing the file

// NOTE: The Language Server offers these as Quick Fixes, and it is the only
// thing that does — but what they change is this file's format, so they are
// computed and tested here.
describe("essence.json — what a reader could do about a mistake", () => {
	function edited(text: string): Array<{ setting: string; text: string }> {
		return settingEdits(text, path.join("/project", PROJECT_FILE_NAME)).map(
			(edit) => {
				let lines = text.split("\n")
				let offsetOf = (cursor: common.Cursor): number => {
					let offset = 0

					for (let line = 1; line < cursor.line; line++) {
						offset += (lines[line - 1] as string).length + 1
					}

					return offset + cursor.column - 1
				}

				return {
					setting: edit.setting,
					text:
						text.slice(0, offsetOf(edit.range.start)) +
						edit.newText +
						text.slice(offsetOf(edit.range.end)),
				}
			},
		)
	}

	it("renames a near miss and leaves its value alone", () => {
		expect(edited(`{\n\t"excludes": ["build"]\n}\n`)).toEqual([
			{ setting: "exclude", text: `{\n\t"exclude": ["build"]\n}\n` },
		])
	})

	it("offers nothing for a key that resembles no setting", () => {
		expect(edited(`{\n\t"zzzz": 1\n}\n`)).toEqual([])
	})

	// NOTE: A setting written FLAT is the same edit a moved one is — the
	// property comes out and goes back in at the path its own name spells.
	it("nests a setting written as a dotted key", () => {
		expect(edited(`{\n\t"test.cases": 200\n}\n`)).toEqual([
			{
				setting: "test.cases",
				text: `{\n\t"test": {\n\t\t"cases": 200\n\t}\n}\n`,
			},
		])
	})

	// NOTE: And the shape a written value can be read as is one span rewritten.
	// The Help and this edit come out of one computation, so a reader is never
	// offered one number and shown another.
	it("writes the author's own value back in the setting's shape", () => {
		expect(
			edited(`{\n\t"build": {\n\t\t"minify": "false"\n\t}\n}\n`),
		).toEqual([
			{
				setting: "build.minify",
				text: `{\n\t"build": {\n\t\t"minify": false\n\t}\n}\n`,
			},
		])
		expect(
			edited(`{\n\t"test": {\n\t\t"skipTags": "wip"\n\t}\n}\n`),
		).toEqual([
			{
				setting: "test.skipTags",
				text: `{\n\t"test": {\n\t\t"skipTags": ["wip"]\n\t}\n}\n`,
			},
		])
	})

	it("offers nothing where the written value coerces to nothing", () => {
		expect(edited(`{\n\t"test": {\n\t\t"cases": "many"\n\t}\n}\n`)).toEqual(
			[],
		)
	})

	// NOTE: The table it leaves behind goes with it — `"test": { }` is a pair
	// of braces nothing reads.
	it("moves a key that has moved, and takes an emptied table along", () => {
		expect(
			edited(`{\n\t"test": {\n\t\t"exclude": ["build"]\n\t}\n}\n`),
		).toEqual([
			{
				setting: "exclude",
				text: `{\n\t"exclude": [\n\t\t"build"\n\t]\n}\n`,
			},
		])
	})

	it("keeps a table that still holds something else", () => {
		let [moved] = edited(
			`{\n\t"test": {\n\t\t"exclude": ["build"],\n\t\t"contracts": true\n\t}\n}\n`,
		)

		expect(moved.text).toContain('"contracts": true')
		expect(moved.text).toContain('"exclude": [')
		expect(moved.text).not.toContain('"test": {\n\t}')
	})

	// NOTE: What is written between the braces is the author's, and a fix that
	// took a sentence away with the key it was about would be deleting the
	// reason the key was there.
	it("keeps a table whose only other content is a Comment", () => {
		let [moved] = edited(
			`{\n\t"test": {\n\t\t// why\n\t\t"exclude": ["build"]\n\t}\n}\n`,
		)

		expect(moved.text).toContain("// why")
	})

	// NOTE: Both values are the author's and only one of them survives the
	// move, so the choice between them is theirs.
	it("offers nothing where the key it would move to is written", () => {
		expect(
			edited(
				`{\n\t"exclude": ["a"],\n\t"test": {\n\t\t"exclude": ["b"]\n\t}\n}\n`,
			),
		).toEqual([])
	})

	// NOTE: jsonc's own property removal reaches back to the previous sibling and
	// takes everything in between, a Comment included. This one does not.
	it("keeps a Comment standing beside the key it moves", () => {
		let [moved] = edited(
			`{\n\t"test": {\n\t\t"exclude": ["build"], // why\n\t\t"contracts": true\n\t}\n}\n`,
		)

		expect(moved.text).toContain('\t\t// why\n\t\t"contracts": true')
	})

	it("leaves no separator behind when the key it moves was written last", () => {
		let [moved] = edited(
			`{\n\t"$schema": "x",\n\t"test": {\n\t\t"exclude": ["build"]\n\t}\n}\n`,
		)

		expect(moved.text).toBe(
			`{\n\t"$schema": "x",\n\t"exclude": [\n\t\t"build"\n\t]\n}\n`,
		)
	})

	it("indents what it writes the way the file indents", () => {
		let [moved] = edited(
			`{\n  "test": {\n    "exclude": ["build"]\n  }\n}\n`,
		)

		expect(moved.text).toBe(`{\n  "exclude": [\n    "build"\n  ]\n}\n`)
	})
})

// #endregion

// #region Finding the file

describe("essence.json — the nearest file governs", () => {
	it("walks up from the directory asked about", async () => {
		await withFiles(
			{
				"essence.json": `{ "test": { "skipTags": ["slow"] } }`,
				"nested/deep/keep.txt": "",
			},
			(directory) => {
				let configuration = readProjectConfiguration(
					path.join(directory, "nested", "deep"),
				)

				expect(configuration.test.skipTags).toEqual(["slow"])
				expect(configuration.root).toBe(directory)
				expect(configuration.problems).toEqual([])
				expect(findProjectFile(path.join(directory, "nested"))).toBe(
					path.join(directory, "essence.json"),
				)
			},
		)
	})

	it("answers the defaults, and no root, where no file governs", async () => {
		await withFiles({ "keep.txt": "" }, (directory) => {
			let configuration = readProjectConfiguration(directory)

			expect(configuration.filePath).toBeNull()
			expect(configuration.root).toBeNull()
			expect(configuration.test).toEqual(defaultConfiguration().test)
		})
	})

	// NOTE: The old home of the settings. A project that has not moved yet is
	// told so ON the key, from any directory the old walk would have read it
	// from, so the symptom is never a silently unconfigured project.
	it("reports the essence key of a package.json as moved", async () => {
		await withFiles(
			{
				"package.json": `{\n\t"name": "x",\n\t"essence": { "exclude": ["broken"] }\n}`,
				"inner/keep.txt": "",
			},
			(directory) => {
				let configuration = readProjectConfiguration(
					path.join(directory, "inner"),
				)
				let [diagnostic] = diagnosticsOf(configuration)

				expect(configuration.exclude).toEqual([])
				expect(configuration.problems[0].filePath).toBe(
					path.join(directory, "package.json"),
				)
				expect(diagnostic.code).toBe("moved-setting")
				expect(diagnostic.message).toBe(
					'The "essence" key of package.json has moved to essence.json',
				)
				expect(diagnostic.position).toEqual({
					start: { line: 3, column: 2 },
					end: { line: 3, column: 11 },
				})
				expect(diagnostic.helps[0]).toContain("essence init")
			},
		)
	})

	it("still reports a stale manifest key under a project that has moved", async () => {
		await withFiles(
			{
				"essence.json": `{ "exclude": ["broken"] }`,
				"package.json": `{ "essence": { "exclude": ["broken"] } }`,
			},
			(directory) => {
				let configuration = readProjectConfiguration(directory)

				expect(configuration.exclude).toEqual([
					path.join(directory, "broken"),
				])
				expect(
					configuration.problems.map((each) => each.filePath),
				).toEqual([path.join(directory, "package.json")])
			},
		)
	})

	it("does not look at manifests above the project root", async () => {
		await withFiles(
			{
				"package.json": `{ "essence": { "exclude": ["broken"] } }`,
				"project/essence.json": `{}`,
			},
			(directory) => {
				let configuration = readProjectConfiguration(
					path.join(directory, "project"),
				)

				expect(configuration.problems).toEqual([])
			},
		)
	})

	it("compares excluded paths as paths", () => {
		let exclude = [path.resolve("/project/fixtures/broken")]

		expect(
			isExcludedPath(
				path.resolve("/project/fixtures/broken/x.es"),
				exclude,
			),
		).toBe(true)
		expect(
			isExcludedPath(
				path.resolve("/project/fixtures/brokenish/x.es"),
				exclude,
			),
		).toBe(false)
	})

	it("walks every source but skipped directories and excluded paths", async () => {
		await withFiles(
			{
				"Main.es": "",
				"notes.txt": "",
				"src/deep/Nested.es": "",
				".git/Object.es": "",
				"node_modules/Package.es": "",
				"fixtures/broken/Broken.es": "",
				"fixtures/brokenish/Kept.es": "",
			},
			async (directory) => {
				let exclude = [path.join(directory, "fixtures", "broken")]
				let found = await essenceFilesUnder(directory, exclude)

				expect(
					found.map((each) => path.relative(directory, each)).sort(),
				).toEqual([
					"Main.es",
					path.join("fixtures", "brokenish", "Kept.es"),
					path.join("src", "deep", "Nested.es"),
				])
			},
		)
	})
})

// #endregion

// #region The cache

describe("essence.json — the cache", () => {
	it("answers one configuration object for every directory under a file", async () => {
		await withFiles(
			{
				"essence.json": `{ "exclude": ["broken"] }`,
				"a/b/c/keep.txt": "",
				"a/d/keep.txt": "",
			},
			(directory) => {
				let cache = createConfigurationCache()
				let deep = cache.forFile(path.join(directory, "a/b/c/File.es"))
				let shallow = cache.forDirectory(path.join(directory, "a/d"))

				expect(deep).toBe(shallow)
				expect(deep).toBe(cache.forDirectory(directory))
				expect(deep.exclude).toEqual([path.join(directory, "broken")])
				expect(cache.known()).toHaveLength(1)
			},
		)
	})

	it("lets a nested project file govern its own files", async () => {
		await withFiles(
			{
				"essence.json": `{ "test": { "skipTags": ["outer"] } }`,
				"inner/essence.json": `{ "test": { "skipTags": ["inner"] } }`,
				"inner/deep/keep.txt": "",
				"other/keep.txt": "",
			},
			(directory) => {
				let cache = createConfigurationCache()

				expect(
					cache.forDirectory(path.join(directory, "inner/deep")).test
						.skipTags,
				).toEqual(["inner"])
				expect(
					cache.forDirectory(path.join(directory, "other")).test
						.skipTags,
				).toEqual(["outer"])
				expect(cache.known()).toHaveLength(2)
			},
		)
	})

	it("forgets everything on clear", async () => {
		await withFiles({ "essence.json": `{}` }, (directory) => {
			let cache = createConfigurationCache()
			let before = cache.forDirectory(directory)

			writeFileSync(
				path.join(directory, "essence.json"),
				`{ "test": { "contracts": true } }`,
			)
			expect(cache.forDirectory(directory)).toBe(before)
			cache.clear()
			expect(cache.forDirectory(directory).test.contracts).toBe(true)
		})
	})

	it("reports a stale manifest against the configuration governing its directory", async () => {
		await withFiles(
			{
				"package.json": `{ "essence": {} }`,
				"src/keep.txt": "",
			},
			(directory) => {
				let cache = createConfigurationCache()
				let configuration = cache.forDirectory(
					path.join(directory, "src"),
				)

				expect(configuration.filePath).toBeNull()
				expect(
					configuration.problems.map((each) => each.filePath),
				).toEqual([path.join(directory, "package.json")])
				// NOTE: Asked again from the manifest's own directory, the
				// problem is not reported twice.
				expect(cache.forDirectory(directory).problems).toHaveLength(1)
			},
		)
	})
})

// #endregion

// #region The Schema

describe("essence.json — the Schema", () => {
	it("is generated from the catalogue", () => {
		let schema = projectSchema() as {
			$id: string
			type: string
			additionalProperties: boolean
			properties: Record<string, Record<string, unknown>>
		}

		expect(schema.$id).toBe(
			"https://essencelang.org/schemas/essence.schema.json",
		)
		expect(schema.type).toBe("object")
		expect(schema.additionalProperties).toBe(false)
		expect(Object.keys(schema.properties)).toEqual([
			"$schema",
			"exclude",
			"test",
			"build",
		])

		let test = schema.properties.test as {
			properties: Record<string, Record<string, unknown>>
		}

		expect(Object.keys(test.properties)).toEqual([
			"skipTags",
			"contracts",
			"cases",
			"coverage",
		])
		expect(test.properties.cases).toEqual({
			description: expect.any(String),
			type: "integer",
			minimum: 1,
		})

		let build = schema.properties.build as {
			properties: Record<string, Record<string, unknown>>
		}

		expect(build.properties.withoutOptimisations).toEqual({
			description: expect.any(String),
			type: "array",
			items: { type: "string", enum: [...optimiserPassNames] },
			uniqueItems: true,
		})
	})
})

// #endregion
