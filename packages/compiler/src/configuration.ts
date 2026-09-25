import { type Dirent, readFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import * as path from "node:path"

import type { common } from "@essence-lang/interfaces"
import {
	applyEdits,
	findNodeAtLocation,
	getNodeValue,
	modify,
	type Node as JsonNode,
	type ParseError,
	parseTree,
	printParseErrorCode,
} from "jsonc-parser"

import { primary } from "./diagnostics"
import { closestMatch } from "./helpers/suggest"
import { optimiserPassNames } from "./optimiser"
import {
	type CoverageReportFormat,
	coverageReportFormats,
} from "./testing/coverageReports"

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

// NOTE: Every `.es` file under a directory, leaving out skipped directories and
// what `exclude` covers. A symlinked directory is read as a file rather than
// descended into, so a link back up the tree can not send the walk round.
export async function essenceFilesUnder(
	directory: string,
	exclude: Array<string> = [],
): Promise<Array<string>> {
	let found: Array<string> = []
	let directories = [directory]

	for (let current of directories) {
		let entries: Array<Dirent>

		try {
			entries = await readdir(current, { withFileTypes: true })
		} catch {
			continue
		}

		for (let entry of entries) {
			let entryPath = path.join(current, entry.name)

			if (entry.isDirectory()) {
				if (
					!skippedDirectories.has(entry.name) &&
					!isExcludedPath(entryPath, exclude)
				) {
					directories.push(entryPath)
				}
			} else if (
				entry.name.endsWith(".es") &&
				!isExcludedPath(entryPath, exclude)
			) {
				found.push(entryPath)
			}
		}
	}

	return found
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

// NOTE: `"test.cases": 200` — a setting written FLAT, the way a command-line
// flag or a dotted property spells one. The catalogue is a TREE, so a key like
// this names a real setting and names it whole; what is missing is the object
// around it. Null for every key that is not one, which is what lets both the
// report and the edit ask this of whatever they are holding.
//
// The parts are walked from the top rather than from where the key stands,
// because a flat key spells the path from the root: `"test.cases"` is the same
// setting written inside `"test"` or outside it.
function nestedSettingPath(keyPath: Array<string>): Array<string> | null {
	let parts = keyPath.flatMap((part) => part.split("."))

	if (parts.length === keyPath.length) {
		return null
	}

	let level: Record<string, Setting> | null = (
		projectSettings.shape as { members: Record<string, Setting> }
	).members

	for (let [index, part] of parts.entries()) {
		let found: Setting | undefined = level?.[part]

		if (found === undefined) {
			return null
		}

		if (index === parts.length - 1) {
			return parts
		}

		level = found.shape.kind === "table" ? found.shape.members : null
	}

	return null
}

// NOTE: The path spelled as the object it is — `"test": { "cases": 200 }` — so
// that what the Help prints is the text a reader writes rather than a
// description of it.
function nestedSpelling(parts: Array<string>, value: unknown): string {
	return parts.reduceRight(
		(inner, part, index) =>
			index === parts.length - 1
				? `${JSON.stringify(part)}: ${inner}`
				: `${JSON.stringify(part)}: { ${inner} }`,
		JSON.stringify(value),
	)
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
	// NOTE: The value that WAS written, written the way the setting takes it.
	// The example is the CATALOGUE's and never the author's, so printing it as
	// the answer said something the file did not: `"minify": "false"` was
	// answered `Write it as true or false: true`, which turns minification ON,
	// and `"cases": "50"` was answered `200`. Where the written value says what
	// was meant, that is what the Help spells; where it does not, the example
	// is offered AS an example.
	let coerced = coercedSettingValue(setting.shape, node)

	warning(
		reading,
		"setting-shape",
		`"${keyPath}" is not ${describeShape(setting.shape)}`,
		node,
		`written as ${written}`,
		[setting.fallback],
		[
			coerced === null
				? `Write it as ${describeShape(setting.shape)} — '${setting.example}', say.`
				: `Write it as ${describeShape(setting.shape)}: ${coerced}`,
		],
		coerced === null
			? undefined
			: {
					kind: "essence-spelling",
					position: spanOf(reading, node),
					spelling: coerced,
				},
	)
}

// NOTE: What the author wrote, read as the value they meant, or null where the
// text says nothing about it — `"cases": "many"` is not a number in a String,
// it is a word, and `"out": ["dist"]` is a list where a path goes with no
// telling whether the rest of the list was meant to go too.
//
// Deliberately narrow. A coercion that guesses is a Help that changes what a
// file says, which is the very thing this exists to stop.
function coercedSettingValue(
	shape: SettingShape,
	node: JsonNode,
): string | null {
	if (shape.kind === "boolean") {
		// NOTE: `0` and `1` and nothing else among the numbers. Every other
		// number is truthy in the language this habit comes from and means
		// nothing in this one.
		if (node.type === "number") {
			return node.value === 0 ? "false" : node.value === 1 ? "true" : null
		}

		return node.type === "string" &&
			(node.value === "true" || node.value === "false")
			? node.value
			: null
	}

	if (shape.kind === "integer") {
		if (node.type !== "string" || !/^[0-9]+$/.test(String(node.value))) {
			return null
		}

		let written = Number(node.value)

		// NOTE: And only where reading it back gives the digits that were
		// written. `Number` rounds past 2^53 — "99999999999999999999" comes
		// back as 100000000000000000000 — and a Help that offers a number
		// nobody wrote is a Help that changes what the file says, which is the
		// one thing this exists to stop.
		if (!Number.isSafeInteger(written)) {
			return null
		}

		return written >= shape.atLeast ? String(written) : null
	}

	// NOTE: One String where a list of them goes is a list of one. The items
	// are names rather than paths in two of the three, and neither is checked
	// here: what this answers is the SHAPE, and a name that is not a pass or a
	// tag is the list reader's own report to make once the brackets are there.
	// NOTE: An EMPTY String is not a list of one: `"skipTags": ""` says the
	// author wants nothing skipped, and `[""]` is a tag no test can carry.
	// Offered as the example instead, which is what says out loud that the
	// brackets are the missing part.
	if (shape.kind === "list") {
		return node.type === "string" && node.value !== ""
			? JSON.stringify([node.value])
			: null
	}

	return null
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
			let nested = nestedSettingPath([...parents, name])
			let near = suggestion !== null && suggestion !== name

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
				// NOTE: Three answers, in the order they are likely. A key that
				// spells a PATH is a setting written flat and is nested; a key
				// one edit from a real one is a misspelling; and a key that is
				// neither is a key nothing reads, which is worth saying as an
				// edit rather than leaving the reader to infer from two Notes.
				// The last used to be silence: `"exclusions"` is three edits
				// from `"exclude"` — past the near-miss rule, and rightly so —
				// so the whole report was two sentences and nothing to do.
				nested !== null
					? [
							`Write it nested: ${nestedSpelling(nested, getNodeValue(property.value))}.`,
						]
					: near
						? [`Did you mean "${suggestion}"?`]
						: [
								"Remove the key, or write one of the settings above.",
							],
				near && nested === null
					? { kind: "suggestion", suggestion: suggestion as string }
					: undefined,
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

// NOTE: The edit jsonc's own verdict names, where it names one. More than half
// of these errors say exactly which Token was expected at the offset, and what
// a reader does about that is write it — one Help per shape, spelling the
// character. Empty for the verdicts that say a character can not stand where it
// does rather than that one is missing: what to write in its place is not
// something the parser knows.
//
// NOTE: And only for the FIRST refusal of the file. jsonc recovers generously,
// and what it says after the first is about text it has already lost track of:
// `{ test: 1 }` is one unquoted key, and its third error asks for "the value the
// key holds" at the `}`, with the value written two characters to the left. One
// mistake is one edit — the rest of the list is the recovery talking, and each
// of those reports keeps its label and the Note that says what the file is.
function parseErrorHelp(error: ParseError, first: boolean): Array<string> {
	if (!first) {
		return []
	}

	switch (printParseErrorCode(error.error)) {
		case "PropertyNameExpected":
			return ["Write a quoted key here."]
		case "ValueExpected":
			return ["Write the value the key holds."]
		case "ColonExpected":
			return ["Write the ':' between the key and its value."]
		case "CommaExpected":
			return ["Write the ',' that separates this from the one above it."]
		case "CloseBraceExpected":
			return ["Write the '}' that closes the object."]
		case "CloseBracketExpected":
			return ["Write the ']' that closes the list."]
		case "EndOfFileExpected":
			return ["Remove what stands after the object."]
		case "InvalidCommentToken":
		case "UnexpectedEndOfComment":
			return ["Close the comment with '*/', or write it as a '//' line."]
		case "UnexpectedEndOfString":
			return ["Write the '\"' that closes the String."]
		default:
			return []
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
				[
					"Every setting is at its default until the file reads.",
					// NOTE: The rule, moved out of the Help it used to be.
					// "The file is JSON with comments allowed" is not an edit
					// anybody makes; it is what a reader has to know to make
					// one, which is what a Note is for.
					"The file is JSON with comments and trailing commas allowed, as tsconfig.json is.",
				],
				// NOTE: And the edit is the Token jsonc says it expected, at
				// the offset the Label already points at.
				parseErrorHelp(error, error === errors[0]),
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
// Editing the file
// ---------------------------------------------------------------------------

// NOTE: What a reader could DO about a setting this file got wrong, as text —
// the Diagnostic it answers, named by the span that Diagnostic was reported at,
// and the smallest change to the file that answers it.
//
// Computed HERE rather than in the Language Server, which is the only thing that
// offers these. The shape of the file is this module's to know: which keys have
// moved and where to, and how a JSONC document is edited without disturbing the
// Comments and the layout around the change. An Editor that worked that out for
// itself would be a second reader of the format, kept in step with this one by
// hand.
export type SettingEdit = {
	code: Extract<
		common.DiagnosticCode,
		"unknown-setting" | "moved-setting" | "setting-shape"
	>
	// NOTE: The Diagnostic this answers, by the span it was reported at — which
	// is what lets an Editor find its own copy of that Diagnostic again.
	position: common.Position
	// NOTE: The span that has to change and what it becomes. One replacement
	// rather than a list, because a MOVE is two changes at two places in the
	// file and the text between them has to survive both: the whole run from the
	// first change to the last is written back, and nothing outside it is
	// touched.
	range: common.Position
	newText: string
	// NOTE: What the setting is called once the edit has landed, which is what
	// tells two of these apart in a list.
	setting: string
}

export function settingEdits(
	sourceText: string,
	filePath: string,
): Array<SettingEdit> {
	let tree = parseTree(sourceText, [], {
		allowTrailingComma: true,
		disallowComments: false,
	})

	if (tree === undefined) {
		return []
	}

	let cursorAt = cursorsOf(sourceText)
	let properties = propertiesOf(tree)
	let edits: Array<SettingEdit> = []

	for (let problem of parseProjectConfiguration(sourceText, filePath)
		.problems) {
		for (let diagnostic of problem.diagnostics) {
			if (diagnostic.position === null) {
				continue
			}

			let edit = settingEdit(
				diagnostic,
				diagnostic.position,
				sourceText,
				tree,
				properties,
				cursorAt,
			)

			if (edit !== null) {
				edits.push(edit)
			}
		}
	}

	return edits
}

// NOTE: A property with the key path it stands under, and its two halves
// already taken apart — a property whose halves can not be read is not one this
// collects, so nothing below has to ask twice.
type KeyedProperty = {
	keyPath: Array<string>
	property: JsonNode
	key: JsonNode
	value: JsonNode
}

function settingEdit(
	diagnostic: common.Diagnostic,
	position: common.Position,
	sourceText: string,
	tree: JsonNode,
	properties: Array<KeyedProperty>,
	cursorAt: (offset: number) => common.Cursor,
): SettingEdit | null {
	// NOTE: A near miss is a rename of the key and nothing else — the value it
	// was written with is what the reader meant either way. The span is the key
	// with its quotes, so the quotes are written back with it.
	if (
		diagnostic.code === "unknown-setting" &&
		diagnostic.data?.kind === "suggestion"
	) {
		return {
			code: "unknown-setting",
			position,
			range: position,
			newText: `"${diagnostic.data.suggestion}"`,
			setting: diagnostic.data.suggestion,
		}
	}

	// NOTE: A shape the written value can be read as is one span rewritten —
	// `"false"` becomes `false`, `"50"` becomes `50`, `"wip"` becomes
	// `["wip"]`. The payload is only there where the coercion held, so a
	// setting whose value says nothing about what was meant carries no edit.
	if (
		diagnostic.code === "setting-shape" &&
		diagnostic.data?.kind === "essence-spelling"
	) {
		return {
			code: "setting-shape",
			position,
			range: position,
			newText: diagnostic.data.spelling,
			setting: diagnostic.message.split('"')[1] ?? "",
		}
	}

	if (
		diagnostic.code !== "moved-setting" &&
		diagnostic.code !== "unknown-setting"
	) {
		return null
	}

	let found = properties.find(({ key }) =>
		cursorsMatch(cursorAt(key.offset), position.start),
	)

	if (found === undefined) {
		return null
	}

	// NOTE: `"test.cases": 200` — a setting written FLAT, which is the same
	// EDIT a moved one is: the property comes out and goes back in at the path
	// its name spells. The near-miss rename above has already answered every
	// unknown key that is one, so what reaches here is a key that is a path or
	// a key that is nothing.
	if (diagnostic.code === "unknown-setting") {
		let nested = nestedSettingPath(found.keyPath)

		return nested === null
			? null
			: movedPropertyEdit(
					"unknown-setting",
					position,
					sourceText,
					tree,
					found,
					nested,
					cursorAt,
				)
	}

	let movedTo = movedSettings[found.keyPath.join(".")]

	// NOTE: Only the keys this table moved. The `essence` key of a
	// `package.json` carries the same code and is not one of them — what moved
	// there is the whole object, into a different FILE, which is no edit to the
	// file being read at all.
	if (movedTo === undefined) {
		return null
	}

	return movedPropertyEdit(
		"moved-setting",
		position,
		sourceText,
		tree,
		found,
		movedTo.split("."),
		cursorAt,
	)
}

// NOTE: One property out and back in at another path — the whole of what both a
// moved setting and a flat one need doing to them. Shared so that the two can
// not drift: they are one edit, differing in how the destination was worked out.
function movedPropertyEdit(
	code: SettingEdit["code"],
	position: common.Position,
	sourceText: string,
	tree: JsonNode,
	found: KeyedProperty,
	destination: Array<string>,
	cursorAt: (offset: number) => common.Cursor,
): SettingEdit | null {
	// NOTE: Withheld where the key it would move to is already written. Both
	// values are the author's and only one of them can survive the move, so the
	// choice between them is theirs rather than an Editor's.
	if (findNodeAtLocation(tree, destination) !== undefined) {
		return null
	}

	let value = getNodeValue(found.value)
	let removed = withoutProperty(
		sourceText,
		emptiedBy(sourceText, found) ?? found.property,
	)
	let written = applyEdits(
		removed,
		modify(removed, destination, value, {
			formattingOptions: indentationOf(sourceText),
		}),
	)

	return {
		code,
		position,
		...replacement(sourceText, written, cursorAt),
		setting: destination.join("."),
	}
}

// NOTE: One property taken out of the document, with the comma that separated
// it from its neighbours and the line it stood on. Hand-written rather than
// `modify`, which is what writes the other half of a move: jsonc's own removal
// reaches back to the previous sibling — or to the opening brace where there is
// none — and takes everything in between, which for a JSONC document means any
// COMMENT standing above the property. What is written between the braces is the
// author's, and no fix here may take a sentence away with the key it was about.
function withoutProperty(sourceText: string, property: JsonNode): string {
	let start = property.offset
	let end = property.offset + property.length
	let following = /^[ \t]*,/.exec(sourceText.slice(end))

	// NOTE: The separator in FRONT is taken only where there is none behind —
	// the property was written last, and the one before it now is. The break
	// between the two goes with it, since the comma it follows is the end of the
	// line the property that keeps it stands on.
	if (following !== null) {
		end += following[0].length
	} else {
		let preceding = /,\s*$/.exec(sourceText.slice(0, start))

		start -= preceding?.[0].length ?? 0
	}

	let lineStart = sourceText.lastIndexOf("\n", start - 1) + 1
	let lineBreak = sourceText.indexOf("\n", end)
	let lineEnd = lineBreak === -1 ? sourceText.length : lineBreak

	// NOTE: A property that had a line to itself takes the line, since what is
	// left of it otherwise is an empty one nothing wrote.
	if (sourceText.slice(lineStart, start).trim() === "") {
		if (sourceText.slice(end, lineEnd).trim() === "") {
			start = lineStart
			end = lineBreak === -1 ? sourceText.length : lineBreak + 1
		} else {
			// NOTE: A Comment behind it keeps the indentation the property had,
			// rather than being pushed one space along by the blank the
			// separator left.
			end += /^[ \t]*/.exec(sourceText.slice(end))?.[0].length ?? 0
		}
	}

	return sourceText.slice(0, start) + sourceText.slice(end)
}

// NOTE: The property holding the table this one is the last thing IN, where
// moving it out would leave `"test": { }` behind — the table goes with it then,
// rather than staying as an empty pair of braces nothing reads. Null where the
// table holds anything else, a COMMENT included: a note written beside a setting
// is about that table, and what survives the move is the reader's to decide.
//
// Read off the text between the braces rather than off the tree, because a
// Comment is exactly what the tree does not hold.
function emptiedBy(
	sourceText: string,
	{ keyPath, property }: KeyedProperty,
): JsonNode | null {
	let table = property.parent
	let owner = table?.parent

	if (
		keyPath.length < 2 ||
		table === undefined ||
		owner === undefined ||
		owner.type !== "property"
	) {
		return null
	}

	let inside =
		sourceText.slice(table.offset + 1, property.offset) +
		sourceText.slice(
			property.offset + property.length,
			table.offset + table.length - 1,
		)

	return /^[\s,]*$/.test(inside) ? owner : null
}

// NOTE: How the file indents, so that what is written into it indents the same
// way. Read off the first line that indents at all; a file with none takes the
// tab every `essence init` writes.
function indentationOf(sourceText: string): {
	tabSize: number
	insertSpaces: boolean
} {
	let indented = /\n([ \t]+)\S/.exec(sourceText)?.[1] ?? "\t"

	return indented.startsWith("\t")
		? { tabSize: 1, insertSpaces: false }
		: { tabSize: indented.length, insertSpaces: true }
}

// NOTE: The two rewrites reduced to the one span they disagree over — the run
// from the first character that differs to the last. Everything a `modify` left
// alone is identical on both sides and stays out of the edit, so a Comment or a
// setting far from the change is never rewritten to the text it already holds.
function replacement(
	before: string,
	after: string,
	cursorAt: (offset: number) => common.Cursor,
): { range: common.Position; newText: string } {
	let start = 0

	while (
		start < before.length &&
		start < after.length &&
		before[start] === after[start]
	) {
		start += 1
	}

	let trailing = 0

	while (
		trailing < before.length - start &&
		trailing < after.length - start &&
		before[before.length - 1 - trailing] ===
			after[after.length - 1 - trailing]
	) {
		trailing += 1
	}

	let end = before.length - trailing

	return {
		range: { start: cursorAt(start), end: cursorAt(end) },
		newText: after.slice(start, after.length - trailing),
	}
}

// NOTE: Every property of the document with the key path it stands under, which
// is what a table of moved keys is looked up by. Collected in one walk rather
// than searched for per Diagnostic: the file is small and the walk is the same
// one either way.
function propertiesOf(
	node: JsonNode,
	parents: Array<string> = [],
): Array<KeyedProperty> {
	if (node.type !== "object") {
		return []
	}

	let collected: Array<KeyedProperty> = []

	for (let child of node.children ?? []) {
		let property = propertyOf(child)

		if (property === null) {
			continue
		}

		let keyPath = [...parents, property.key.value as string]

		collected.push({ keyPath, property: child, ...property })
		collected.push(...propertiesOf(property.value, keyPath))
	}

	return collected
}

function cursorsMatch(a: common.Cursor, b: common.Cursor): boolean {
	return a.line === b.line && a.column === b.column
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
