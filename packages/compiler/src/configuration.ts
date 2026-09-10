import { readFileSync } from "node:fs"
import * as path from "node:path"

import type { common } from "@essence-lang/interfaces"
import {
	getNodeValue,
	type Node as JsonNode,
	type ParseError,
	parseTree,
	printParseErrorCode,
} from "jsonc-parser"

import { primary } from "./diagnostics"
import { closestMatch } from "./helpers/suggest"
import { optimiserPassNames } from "./optimiser"

// NOTE: A project's settings live in ONE file at its root, `essence.json`, and
// everything that walks or builds the project reads them there: `essence
// test`, `essence build`, the Language Server's discovery walk, the Editor's
// live test session. The file is JSON with comments and trailing commas, the
// way `tsconfig.json` and `deno.json` read theirs, because a project file is
// where the reasons behind a setting get written down — WHY a directory is not
// a source — and a format that forbids that is a format people annotate in a
// README nobody opens.
//
// NOTE: Where the file is IS the project root. The old arrangement, settings
// under an `essence` key of the nearest `package.json` that had one, gave a
// project two roots — the settings were found by walking up while every walk
// started at the working directory — and two spellings of the same list, one
// in the manifest and one in the Editor's settings. A file the project owns
// answers both: the directory holding it is what a run walks, and what it says
// is what every tool reads. The `essence` key of a manifest is no longer read,
// and is reported as moved when one is found.
//
// NOTE: Read synchronously, because the two walks that need the answer are
// themselves synchronous — the Language Server's discovery walk runs inside a
// request — and one implementation that both can call is worth more than the
// asynchrony. It is a handful of small files, once, at the start of a run.
//
// NOTE: A mistake in the file is a WARNING with a span, never a refusal: a
// project should not fail to run its tests because a key it added is the wrong
// shape, and silence would leave the author believing a filter is in force
// when it is not. The setting falls back to its default and the Diagnostic
// says so, rendered by the same renderer as every other Diagnostic — in the
// terminal at the head of a run, and on the file itself in the Editor.

export const PROJECT_FILE_NAME = "essence.json"

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

export type CoverageReportFormat = "lcov" | "json"

export const coverageReportFormats: ReadonlyArray<CoverageReportFormat> = [
	"lcov",
	"json",
]

export type TestConfiguration = {
	skipTags: Array<string>
	// NOTE: Whether every run of this project also tests what its declarations
	// promise — see `--contracts`. A project whose goals are worth running is a
	// project whose goals are worth running every time, and `--contracts` is
	// then the flag for asking about a project that did not say so. The two are
	// a union: either one turns the goals on.
	contracts: boolean
	// NOTE: How many values a property test draws. Null when the project did
	// not say, so that the runner's own default stays spelled in one place —
	// the runner — rather than here as well.
	cases: number | null
	coverage: {
		// NOTE: The report a `--coverage` run writes. Null when the project did
		// not ask for one; collecting coverage is a choice about a run and stays
		// a flag, while the format and the directory are facts about the
		// project and live here.
		report: CoverageReportFormat | null
		// NOTE: Absolute, resolved against the project file. Null when the
		// project did not say, which the runner answers with `coverage/` under
		// the working directory as it always has.
		out: string | null
	}
}

export type BuildConfiguration = {
	// NOTE: Absolute, resolved against the project file. Null for the default,
	// which is next to each source file.
	out: string | null
	sourcemap: boolean
	minify: boolean
	embed: boolean
	optimise: boolean
	withoutOptimisations: Array<string>
}

// NOTE: One file's worth of problems — the file, its text and the Diagnostics
// read out of it — which is exactly what a renderer needs to show them. A
// configuration may carry more than one: the project file's own, and a
// `package.json` that still spells the old key.
export type ProjectProblems = {
	filePath: string
	sourceText: string
	diagnostics: Array<common.Diagnostic>
}

export type ProjectConfiguration = {
	// NOTE: The project file the settings were read from, for `--verbose` and
	// for the Diagnostics. Null when no project file governs the path asked
	// about, in which case every setting is at its default.
	filePath: string | null
	// NOTE: The directory holding the project file — what a run walks. Null
	// exactly when `filePath` is.
	root: string | null
	// NOTE: Absolute paths a discovery walk never descends into, resolved
	// against the project file that named them. A file NAMED on the command
	// line is still compiled and still reported, and a file OPENED in the
	// editor still gets its Diagnostics: what this excludes is the walk, which
	// is the half nobody asked for by name.
	exclude: Array<string>
	test: TestConfiguration
	build: BuildConfiguration
	// NOTE: What was written but could not be read as a setting, as Diagnostics
	// against the file that holds it. Warnings, every one — see the head of
	// this file.
	problems: Array<ProjectProblems>
}

// NOTE: THE spelling of the defaults — every path that could not read a value
// falls back to these, so a field added here can not default differently on
// the path that could not read the file.
export function defaultConfiguration(): ProjectConfiguration {
	return {
		filePath: null,
		root: null,
		exclude: [],
		test: {
			skipTags: [],
			contracts: false,
			cases: null,
			coverage: { report: null, out: null },
		},
		build: {
			out: null,
			sourcemap: false,
			minify: false,
			embed: false,
			optimise: true,
			withoutOptimisations: [],
		},
		problems: [],
	}
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

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

// NOTE: Every setting the file may hold, as data: its shape, what it is for,
// and what happens when it can not be read. The reader walks the file against
// this, so an unknown key, a wrong shape and the "did you mean" all come from
// one place; the JSON Schema an Editor validates the file with is GENERATED
// from it (see `projectSchema`), so the two can not drift; and the
// documentation strings here are the ones the Editor shows on hover.
export type SettingShape =
	| { kind: "string" }
	| { kind: "boolean" }
	| { kind: "path" }
	| { kind: "integer"; atLeast: number }
	| { kind: "choice"; of: ReadonlyArray<string> }
	| { kind: "list"; of: "path" | "tag" | "pass" }
	| { kind: "table"; members: Record<string, Setting> }

export type Setting = {
	shape: SettingShape
	description: string
	// NOTE: What a run does when the setting could not be read — the note the
	// Diagnostic ends on, so the reader knows what is in force meanwhile.
	fallback: string
	// NOTE: One valid value, spelled as it would be written, for the Help.
	example: string
}

function setting(
	shape: SettingShape,
	description: string,
	fallback: string,
	example: string,
): Setting {
	return { shape, description, fallback, example }
}

function table(
	members: Record<string, Setting>,
	description: string,
	fallback: string,
	example: string,
): Setting {
	return { shape: { kind: "table", members }, description, fallback, example }
}

export const projectSettings: Setting = table(
	{
		$schema: setting(
			{ kind: "string" },
			"The JSON Schema this file is checked against. Read by editors, ignored by Essence.",
			"Nothing changes; Essence never reads it.",
			'"https://essencelang.org/schemas/essence.schema.json"',
		),
		exclude: setting(
			{ kind: "list", of: "path" },
			"Directories under this project that are not its sources: a corpus kept broken on purpose, a vendored copy. Paths relative to this file, not globs. A file named on the command line or open in the editor is still compiled; this narrows the walk.",
			"Nothing is excluded from the walk.",
			'["fixtures/broken"]',
		),
		test: table(
			{
				skipTags: setting(
					{ kind: "list", of: "tag" },
					"Tags an everyday `essence test` leaves out. `--tag` brings one back for a run.",
					"No tag is skipped by default.",
					'["slow"]',
				),
				contracts: setting(
					{ kind: "boolean" },
					"Whether every run also tests what the declarations promise, as `--contracts` does for one run. `--no-contracts` turns it off for a run.",
					"The contract goals are left out.",
					"true",
				),
				cases: setting(
					{ kind: "integer", atLeast: 1 },
					"How many values each property test draws. `--cases` overrides it for a run.",
					"Property tests draw the runner's default number of values.",
					"200",
				),
				coverage: table(
					{
						report: setting(
							{ kind: "choice", of: coverageReportFormats },
							"The report a `--coverage` run writes, as `--coverage-report` names it.",
							"No coverage report is written.",
							'"lcov"',
						),
						out: setting(
							{ kind: "path" },
							"Where a coverage report is written, relative to this file, as `--coverage-out` names it.",
							"Reports are written to `coverage/` under the working directory.",
							'"coverage"',
						),
					},
					"How and where a coverage report is written when a run asks for one.",
					"No coverage report is written, and none has a place to go.",
					'{ "report": "lcov", "out": "coverage" }',
				),
			},
			"How `essence test` runs this project.",
			"Every test setting is at its default.",
			'{ "skipTags": ["slow"], "contracts": true }',
		),
		build: table(
			{
				out: setting(
					{ kind: "path" },
					"Where bundles are written, relative to this file, as `--out` names it.",
					"Bundles are written next to each source file.",
					'"dist"',
				),
				sourcemap: setting(
					{ kind: "boolean" },
					"Whether a source map is written beside every bundle, as `--sourcemap` asks for one run.",
					"No source map is written.",
					"true",
				),
				minify: setting(
					{ kind: "boolean" },
					"Whether bundles are minified, as `--minify` asks for one run.",
					"Bundles are not minified.",
					"true",
				),
				embed: setting(
					{ kind: "boolean" },
					"Whether every bundle is built for embedding, with its descriptor beside it, as `--embed` asks for one run.",
					"Bundles are built to run on their own.",
					"true",
				),
				optimise: setting(
					{ kind: "boolean" },
					"Whether the Optimiser runs. `false` is what `--no-optimise` says for one run.",
					"The Optimiser runs.",
					"false",
				),
				withoutOptimisations: setting(
					{ kind: "list", of: "pass" },
					"Optimiser passes left out, by name, as `--without-optimisation` names them one at a time.",
					"Every pass runs.",
					'["pool-constants"]',
				),
			},
			"How this project's bundles are made: the flags `build`, `run` and `watch` take, said once.",
			"Every build setting is at its default.",
			'{ "out": "dist", "sourcemap": true }',
		),
	},
	"The Essence project file.",
	"Every setting is at its default.",
	"{ }",
)

// NOTE: The names a `list` holds, for the messages and the Schema.
const listItemNames: Record<"path" | "tag" | "pass", string> = {
	path: "paths",
	tag: "tag names",
	pass: "Optimiser pass names",
}

function describeShape(shape: SettingShape): string {
	switch (shape.kind) {
		case "string":
			return "a String"
		case "boolean":
			return "true or false"
		case "path":
			return "a path"
		case "integer":
			return `a whole number of at least ${shape.atLeast}`
		case "choice":
			return shape.of.map((each) => `"${each}"`).join(" or ")
		case "list":
			return `a list of ${listItemNames[shape.of]}`
		case "table":
			return "an object"
	}
}

// ---------------------------------------------------------------------------
// The JSON Schema
// ---------------------------------------------------------------------------

export const PROJECT_SCHEMA_URL =
	"https://essencelang.org/schemas/essence.schema.json"

type JsonSchema = Record<string, unknown>

function schemaOf(setting: Setting): JsonSchema {
	let shape = setting.shape
	let base: JsonSchema = { description: setting.description }

	switch (shape.kind) {
		case "string":
		case "path":
			return { ...base, type: "string" }
		case "boolean":
			return { ...base, type: "boolean" }
		case "integer":
			return { ...base, type: "integer", minimum: shape.atLeast }
		case "choice":
			return { ...base, type: "string", enum: [...shape.of] }
		case "list":
			return {
				...base,
				type: "array",
				items:
					shape.of === "pass"
						? { type: "string", enum: [...optimiserPassNames] }
						: { type: "string" },
				uniqueItems: true,
			}
		case "table":
			return {
				...base,
				type: "object",
				properties: Object.fromEntries(
					Object.entries(shape.members).map(([name, member]) => [
						name,
						schemaOf(member),
					]),
				),
				additionalProperties: false,
			}
	}
}

// NOTE: The Schema, generated from the catalogue rather than written beside
// it. The checked-in copies — the one the VS Code extension ships and the one
// the website serves — are compared against this by a spec, so a setting
// added above is a Schema change the suite insists on.
export function projectSchema(): JsonSchema {
	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: PROJECT_SCHEMA_URL,
		title: "Essence project file",
		...schemaOf(projectSettings),
	}
}

// ---------------------------------------------------------------------------
// Reading one file
// ---------------------------------------------------------------------------

// NOTE: Offsets to Cursors, for the Diagnostics. Lines and columns are
// one-based, as the Lexer's are, so a Position in this file renders and
// underlines exactly like one in a source.
function cursorsOf(text: string): (offset: number) => common.Cursor {
	let lineStarts = [0]

	for (let index = 0; index < text.length; index++) {
		if (text[index] === "\n") {
			lineStarts.push(index + 1)
		}
	}

	return (offset) => {
		let low = 0
		let high = lineStarts.length - 1

		while (low < high) {
			let middle = Math.ceil((low + high) / 2)

			if (lineStarts[middle] <= offset) {
				low = middle
			} else {
				high = middle - 1
			}
		}

		return { line: low + 1, column: offset - lineStarts[low] + 1 }
	}
}

type Reading = {
	filePath: string
	directory: string
	cursorAt: (offset: number) => common.Cursor
	diagnostics: Array<common.Diagnostic>
}

function spanOf(reading: Reading, node: JsonNode): common.Position {
	return {
		start: reading.cursorAt(node.offset),
		end: reading.cursorAt(node.offset + node.length),
	}
}

function warning(
	reading: Reading,
	code: common.DiagnosticCode,
	message: string,
	node: JsonNode,
	label: string,
	notes: Array<string>,
	helps: Array<string>,
	data?: common.DiagnosticData,
): void {
	let position = spanOf(reading, node)

	reading.diagnostics.push({
		severity: "warning",
		message,
		code,
		position,
		labels: [primary(position, label)],
		notes,
		helps,
		...(data === undefined ? {} : { data }),
	})
}

function describeNode(node: JsonNode): string {
	switch (node.type) {
		case "string":
			return "a String"
		case "number":
			return "a number"
		case "boolean":
			return "true or false"
		case "null":
			return "null"
		case "array":
			return "a list"
		case "object":
			return "an object"
		case "property":
			return "a property"
	}
}

function keyPathOf(parents: Array<string>, name: string): string {
	return [...parents, name].join(".")
}

// NOTE: The one Diagnostic every wrong shape gets. It names the setting, says
// what was written instead, spells one right value, and ends on what is in
// force meanwhile — the last being the point: a setting that did not read is a
// setting the author believes is in force.
function wrongShape(
	reading: Reading,
	keyPath: string,
	setting: Setting,
	node: JsonNode,
	written: string = describeNode(node),
): void {
	warning(
		reading,
		"setting-shape",
		`"${keyPath}" is not ${describeShape(setting.shape)}`,
		node,
		`written as ${written}`,
		[setting.fallback],
		[`Write it as ${describeShape(setting.shape)}: ${setting.example}`],
	)
}

// NOTE: The keys of a `property` node: `[key, value]`. A property with no value
// — `"a": ` and then the closing brace — parses with one child, and is a shape
// the walk reports rather than reads.
function propertyOf(node: JsonNode): { key: JsonNode; value: JsonNode } | null {
	let [key, value] = node.children ?? []

	if (key === undefined || key.type !== "string" || value === undefined) {
		return null
	}

	return { key, value }
}

function readString(
	reading: Reading,
	keyPath: string,
	setting: Setting,
	node: JsonNode,
): string | null {
	if (node.type !== "string" || typeof node.value !== "string") {
		wrongShape(reading, keyPath, setting, node)

		return null
	}

	return node.value
}

function readBoolean(
	reading: Reading,
	keyPath: string,
	setting: Setting,
	node: JsonNode,
): boolean | null {
	if (node.type !== "boolean" || typeof node.value !== "boolean") {
		wrongShape(reading, keyPath, setting, node)

		return null
	}

	return node.value
}

function readInteger(
	reading: Reading,
	keyPath: string,
	setting: Setting,
	atLeast: number,
	node: JsonNode,
): number | null {
	if (node.type !== "number" || typeof node.value !== "number") {
		wrongShape(reading, keyPath, setting, node)

		return null
	}

	if (!Number.isInteger(node.value)) {
		wrongShape(reading, keyPath, setting, node, "a fraction")

		return null
	}

	if (node.value < atLeast) {
		wrongShape(reading, keyPath, setting, node, `${node.value}`)

		return null
	}

	return node.value
}

function readChoice(
	reading: Reading,
	keyPath: string,
	setting: Setting,
	choices: ReadonlyArray<string>,
	node: JsonNode,
): string | null {
	if (node.type !== "string" || typeof node.value !== "string") {
		wrongShape(reading, keyPath, setting, node)

		return null
	}

	if (!choices.includes(node.value)) {
		let suggestion = closestMatch(node.value, [...choices])

		warning(
			reading,
			"setting-shape",
			`"${keyPath}" is not ${describeShape(setting.shape)}`,
			node,
			`"${node.value}" is not one of them`,
			[setting.fallback],
			suggestion === null
				? [`Write one of ${describeShape(setting.shape)}.`]
				: [`Did you mean "${suggestion}"?`],
			suggestion === null
				? undefined
				: { kind: "suggestion", suggestion },
		)

		return null
	}

	return node.value
}

// NOTE: A list is read item by item: one item of the wrong shape is reported
// on that item and left out, and the rest are kept. A whole list dropped over
// one typo would be a project with no exclusions and a Problems panel full of
// its corpus, which is the failure this file exists to prevent.
function readList(
	reading: Reading,
	keyPath: string,
	setting: Setting,
	of: "path" | "tag" | "pass",
	node: JsonNode,
): Array<string> | null {
	if (node.type !== "array") {
		wrongShape(reading, keyPath, setting, node)

		return null
	}

	let items: Array<string> = []

	for (let item of node.children ?? []) {
		if (item.type !== "string" || typeof item.value !== "string") {
			warning(
				reading,
				"setting-shape",
				`"${keyPath}" holds something that is not one of its ${listItemNames[of]}`,
				item,
				`written as ${describeNode(item)}`,
				["This item is left out; the rest of the list is read."],
				[`Write every item as a String: ${setting.example}`],
			)

			continue
		}

		if (of === "pass" && !optimiserPassNames.includes(item.value)) {
			let suggestion = closestMatch(item.value, [...optimiserPassNames])

			warning(
				reading,
				"setting-shape",
				`"${item.value}" is not an Optimiser pass`,
				item,
				"no pass by this name",
				[
					"This item is left out; the rest of the list is read.",
					`The passes are ${optimiserPassNames.join(", ")}.`,
				],
				suggestion === null ? [] : [`Did you mean "${suggestion}"?`],
				suggestion === null
					? undefined
					: { kind: "suggestion", suggestion },
			)

			continue
		}

		items.push(
			of === "path"
				? path.resolve(reading.directory, item.value)
				: item.value,
		)
	}

	return items
}

// NOTE: The keys that USED to be read somewhere else, and where they went.
// Reported rather than silently unknown, because the symptom of a key in the
// wrong place is a setting the author believes is in force — a Problems panel
// full of a corpus a project deliberately keeps broken reads as the editor
// being wrong rather than as a key having moved.
const movedSettings: Record<string, string> = {
	"test.exclude": "exclude",
}

// NOTE: Every member of a table that is not one of the table's settings. The
// only place an unknown key is reported, so the message is uniform: what the
// table holds, and the nearest of them if the key is a near miss.
function readTable(
	reading: Reading,
	parents: Array<string>,
	members: Record<string, Setting>,
	node: JsonNode,
	values: Map<string, unknown>,
): void {
	let names = Object.keys(members)

	for (let child of node.children ?? []) {
		let property = propertyOf(child)

		if (property === null) {
			continue
		}

		let name = property.key.value as string
		let keyPath = keyPathOf(parents, name)
		let member = members[name]

		if (member === undefined) {
			let movedTo = movedSettings[keyPath]

			if (movedTo !== undefined) {
				warning(
					reading,
					"moved-setting",
					`"${keyPath}" has moved to "${movedTo}"`,
					property.key,
					"no longer read here",
					[
						`"${movedTo}" keeps the editor out of those directories as well as the test walk, so it sits at the top rather than under "test".`,
						"Nothing was read from this key.",
					],
					[
						`Move it: "${movedTo}": ${JSON.stringify(getNodeValue(property.value))}`,
					],
				)

				continue
			}

			let suggestion = closestMatch(name, names)
			let where =
				parents.length === 0
					? "at the top of essence.json"
					: `under "${parents.join(".")}"`

			warning(
				reading,
				"unknown-setting",
				`"${keyPath}" is not a setting`,
				property.key,
				"not a setting",
				[
					`The settings ${where} are ${names.map((each) => `"${each}"`).join(", ")}.`,
					"Nothing was read from this key.",
				],
				suggestion === null || suggestion === name
					? []
					: [`Did you mean "${suggestion}"?`],
				suggestion === null || suggestion === name
					? undefined
					: { kind: "suggestion", suggestion },
			)

			continue
		}

		let shape = member.shape

		switch (shape.kind) {
			case "table": {
				if (property.value.type !== "object") {
					wrongShape(reading, keyPath, member, property.value)

					break
				}

				readTable(
					reading,
					[...parents, name],
					shape.members,
					property.value,
					values,
				)

				break
			}
			case "string": {
				let read = readString(reading, keyPath, member, property.value)

				if (read !== null) {
					values.set(keyPath, read)
				}

				break
			}
			case "path": {
				let read = readString(reading, keyPath, member, property.value)

				if (read !== null) {
					values.set(keyPath, path.resolve(reading.directory, read))
				}

				break
			}
			case "boolean": {
				let read = readBoolean(reading, keyPath, member, property.value)

				if (read !== null) {
					values.set(keyPath, read)
				}

				break
			}
			case "integer": {
				let read = readInteger(
					reading,
					keyPath,
					member,
					shape.atLeast,
					property.value,
				)

				if (read !== null) {
					values.set(keyPath, read)
				}

				break
			}
			case "choice": {
				let read = readChoice(
					reading,
					keyPath,
					member,
					shape.of,
					property.value,
				)

				if (read !== null) {
					values.set(keyPath, read)
				}

				break
			}
			case "list": {
				let read = readList(
					reading,
					keyPath,
					member,
					shape.of,
					property.value,
				)

				if (read !== null) {
					values.set(keyPath, read)
				}

				break
			}
		}
	}
}

// NOTE: What jsonc-parser says about a syntax error, as a sentence. Its codes
// are `PropertyNameExpected` and the like — readable, but not to a reader who
// did not write the parser.
function describeParseError(error: ParseError): string {
	switch (printParseErrorCode(error.error)) {
		case "InvalidSymbol":
			return "this is not JSON"
		case "InvalidNumberFormat":
			return "this is not a number JSON can read"
		case "PropertyNameExpected":
			return "a quoted key was expected here"
		case "ValueExpected":
			return "a value was expected here"
		case "ColonExpected":
			return "a ':' was expected here"
		case "CommaExpected":
			return "a ',' was expected here"
		case "CloseBraceExpected":
			return "a '}' was expected here"
		case "CloseBracketExpected":
			return "a ']' was expected here"
		case "EndOfFileExpected":
			return "nothing more was expected after the object"
		case "InvalidCommentToken":
			return "this comment is not closed"
		case "UnexpectedEndOfComment":
			return "this comment is not closed"
		case "UnexpectedEndOfString":
			return "this String is not closed"
		case "UnexpectedEndOfNumber":
			return "this number is cut short"
		case "InvalidUnicode":
			return "this is not a Unicode escape"
		case "InvalidEscapeCharacter":
			return "this is not an escape JSON knows"
		case "InvalidCharacter":
			return "this character can not stand in a String"
		default:
			return "this could not be read"
	}
}

// NOTE: Pure: text in, configuration out. The Language Server reads an unsaved
// buffer through this, and the tests read a String; `readProjectConfiguration`
// is this plus the disk.
export function parseProjectConfiguration(
	sourceText: string,
	filePath: string,
): ProjectConfiguration {
	let configuration = defaultConfiguration()
	let resolvedPath = path.resolve(filePath)
	let directory = path.dirname(resolvedPath)
	let reading: Reading = {
		filePath: resolvedPath,
		directory,
		cursorAt: cursorsOf(sourceText),
		diagnostics: [],
	}
	configuration.filePath = resolvedPath
	configuration.root = directory

	// NOTE: An empty file is a project with nothing to say, which is allowed:
	// the file still marks the root. Answered before the parse, which would
	// otherwise report the value it did not find.
	if (sourceText.trim() === "") {
		return configuration
	}

	let errors: Array<ParseError> = []
	let tree = parseTree(sourceText, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	})

	// NOTE: A file that does not parse is a file whose every setting is at its
	// default, said once per error at the place it happened. What DID parse is
	// deliberately not read: jsonc-parser recovers generously, and a setting
	// read out of the half of a file before a missing brace is a setting the
	// author can not predict.
	if (errors.length > 0) {
		for (let error of errors) {
			let node: JsonNode = {
				type: "null",
				offset: error.offset,
				length: Math.max(1, error.length),
			}

			warning(
				reading,
				"unreadable-project-file",
				`${PROJECT_FILE_NAME} could not be read as JSON`,
				node,
				describeParseError(error),
				["Every setting is at its default until the file reads."],
				[
					"The file is JSON with comments and trailing commas allowed, as tsconfig.json is.",
				],
			)
		}

		configuration.problems.push({
			filePath: resolvedPath,
			sourceText,
			diagnostics: reading.diagnostics,
		})

		return configuration
	}

	if (tree === undefined || tree.type !== "object") {
		wrongShape(
			reading,
			PROJECT_FILE_NAME,
			projectSettings,
			tree ?? { type: "null", offset: 0, length: sourceText.length },
		)
		configuration.problems.push({
			filePath: resolvedPath,
			sourceText,
			diagnostics: reading.diagnostics,
		})

		return configuration
	}

	let values = new Map<string, unknown>()

	readTable(
		reading,
		[],
		(projectSettings.shape as { members: Record<string, Setting> }).members,
		tree,
		values,
	)

	let read = <Value>(keyPath: string, fallback: Value): Value =>
		values.has(keyPath) ? (values.get(keyPath) as Value) : fallback

	configuration.exclude = read("exclude", [])
	configuration.test = {
		skipTags: read("test.skipTags", []),
		contracts: read("test.contracts", false),
		cases: read("test.cases", null),
		coverage: {
			report: read("test.coverage.report", null),
			out: read("test.coverage.out", null),
		},
	}
	configuration.build = {
		out: read("build.out", null),
		sourcemap: read("build.sourcemap", false),
		minify: read("build.minify", false),
		embed: read("build.embed", false),
		optimise: read("build.optimise", true),
		withoutOptimisations: read("build.withoutOptimisations", []),
	}

	if (reading.diagnostics.length > 0) {
		configuration.problems.push({
			filePath: resolvedPath,
			sourceText,
			diagnostics: reading.diagnostics,
		})
	}

	return configuration
}

// ---------------------------------------------------------------------------
// Finding the file
// ---------------------------------------------------------------------------

function readText(filePath: string): string | null {
	try {
		return readFileSync(filePath, "utf8")
	} catch {
		return null
	}
}

// NOTE: The nearest project file at or above a directory, or null. The walk
// stops at the filesystem root, which is its own parent — comparing the two is
// how the walk knows it.
export function findProjectFile(from: string): string | null {
	let directory = path.resolve(from)

	while (true) {
		let candidate = path.join(directory, PROJECT_FILE_NAME)

		if (readText(candidate) !== null) {
			return candidate
		}

		let parent = path.dirname(directory)

		if (parent === directory) {
			return null
		}

		directory = parent
	}
}

// NOTE: The manifests between a directory and a root, nearest first — the
// files that used to hold the settings and may still spell them. With a
// project file, the walk stops at the project root: a manifest above it
// belongs to something else. Without one, it goes to the filesystem root, the
// way the old reader did, so a project that has not moved yet is told so from
// every directory it used to be configured from.
function manifestsAbove(from: string, root: string | null): Array<string> {
	let directory = path.resolve(from)
	let found: Array<string> = []

	while (true) {
		found.push(path.join(directory, "package.json"))

		let parent = path.dirname(directory)

		if (parent === directory || directory === root) {
			return found
		}

		directory = parent
	}
}

// NOTE: An `essence` key in a `package.json`, reported as moved on the key
// itself. It is looked for in every manifest the old walk would have read, so
// the report appears wherever the old setting would have been in force.
function movedManifestProblems(
	from: string,
	root: string | null,
): Array<ProjectProblems> {
	let problems: Array<ProjectProblems> = []

	for (let manifestPath of manifestsAbove(from, root)) {
		let text = readText(manifestPath)

		if (text === null || !text.includes('"essence"')) {
			continue
		}

		let tree = parseTree(text, [], { allowTrailingComma: true })
		let property = tree?.children?.find(
			(child) => propertyOf(child)?.key.value === "essence",
		)

		if (tree === undefined || property === undefined) {
			continue
		}

		let key = propertyOf(property)?.key

		if (key === undefined) {
			continue
		}

		let reading: Reading = {
			filePath: manifestPath,
			directory: path.dirname(manifestPath),
			cursorAt: cursorsOf(text),
			diagnostics: [],
		}

		warning(
			reading,
			"moved-setting",
			`The "essence" key of package.json has moved to ${PROJECT_FILE_NAME}`,
			key,
			"no longer read",
			[
				`A project's settings live in an ${PROJECT_FILE_NAME} at its root, which every tool reads: the test run, the build, and the editor.`,
				"Nothing was read from this key.",
			],
			[
				`Move the object into ${PROJECT_FILE_NAME} beside this file — \`essence init\` writes one to start from.`,
			],
		)
		problems.push({
			filePath: manifestPath,
			sourceText: text,
			diagnostics: reading.diagnostics,
		})
	}

	return problems
}

// NOTE: The configuration governing a directory: the nearest project file at
// or above it, read, with any manifest that still spells the old key reported
// beside it. This is the one entry point for a caller that reads once — the
// commands. A caller that asks per file, the Language Server's walk, holds a
// `ConfigurationCache` instead, which answers this once per directory.
export function readProjectConfiguration(
	from: string = process.cwd(),
): ProjectConfiguration {
	let filePath = findProjectFile(from)
	let configuration: ProjectConfiguration

	if (filePath === null) {
		configuration = defaultConfiguration()
	} else {
		configuration = parseProjectConfiguration(
			readText(filePath) ?? "",
			filePath,
		)
	}

	configuration.problems.push(
		...movedManifestProblems(from, configuration.root),
	)

	return configuration
}

// NOTE: A configuration per directory, answered once and held. A walk over a
// project asks for every directory it enters, and a Language Server asks for
// every file it reports on; both would otherwise read the same handful of
// files thousands of times. Directories under one project file share ONE
// configuration object, so identity says whether two files are governed by the
// same settings.
//
// `clear` forgets everything, and is what a project file changing calls: a
// project drawing its own boundary somewhere else is a different project from
// the one every cached answer was derived for.
export type ConfigurationCache = {
	forDirectory(directory: string): ProjectConfiguration
	forFile(filePath: string): ProjectConfiguration
	// NOTE: Every distinct configuration read so far — one per project file
	// met, plus the one default for directories no file governs — which is
	// what a caller reporting the problems asks for.
	known(): Array<ProjectConfiguration>
	clear(): void
}

export function createConfigurationCache(): ConfigurationCache {
	let byDirectory = new Map<string, ProjectConfiguration>()
	let unconfigured: ProjectConfiguration | null = null

	// NOTE: A manifest in THIS directory that still spells the old key is
	// reported against the configuration that governs the directory, whichever
	// file that is — or the default, when none — and only once per manifest.
	function addManifestProblems(
		directory: string,
		configuration: ProjectConfiguration,
	): void {
		for (let problem of movedManifestProblems(directory, directory)) {
			if (
				!configuration.problems.some(
					(held) => held.filePath === problem.filePath,
				)
			) {
				configuration.problems.push(problem)
			}
		}
	}

	function resolve(directory: string): ProjectConfiguration {
		let held = byDirectory.get(directory)

		if (held !== undefined) {
			return held
		}

		let candidate = path.join(directory, PROJECT_FILE_NAME)
		let text = readText(candidate)
		let answer: ProjectConfiguration

		if (text !== null) {
			answer = parseProjectConfiguration(text, candidate)
		} else {
			let parent = path.dirname(directory)

			if (parent === directory) {
				unconfigured ??= defaultConfiguration()
				answer = unconfigured
			} else {
				answer = resolve(parent)
			}
		}

		addManifestProblems(directory, answer)
		byDirectory.set(directory, answer)

		return answer
	}

	return {
		forDirectory(directory) {
			return resolve(path.resolve(directory))
		},
		forFile(filePath) {
			return resolve(path.dirname(path.resolve(filePath)))
		},
		known() {
			return [...new Set(byDirectory.values())]
		},
		clear() {
			byDirectory.clear()
			unconfigured = null
		},
	}
}
