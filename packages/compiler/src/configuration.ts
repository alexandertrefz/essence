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

// The project file, `essence.json`, which every command and the language
// server read. Its directory is the project root. A mistake in it is a warning,
// and the setting keeps its default. See "The project file" in DEVELOPMENT.md.

export const PROJECT_FILE_NAME = "essence.json"

// The directories no discovery walk descends into. The compiler's walk and the
// language server's share this, so they agree on which files a project holds.
export const skippedDirectories = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	".claude",
])

export type TestConfiguration = {
	skipTags: Array<string>
	// Whether every run tests what the declarations promise. Either this or
	// `--contracts` turns the goals on.
	contracts: boolean
	// How many values a property test draws. Null leaves the runner's default.
	cases: number | null
	coverage: {
		// The report a `--coverage` run writes, or null for none. Collecting
		// coverage stays a flag, since it is a choice about one run.
		report: CoverageReportFormat | null
		// Absolute, resolved against the project file. Null leaves the
		// runner's `coverage/` under the working directory.
		out: string | null
	}
}

export type BuildConfiguration = {
	// Absolute, resolved against the project file. Null writes each bundle
	// next to its source file.
	out: string | null
	sourcemap: boolean
	minify: boolean
	embed: boolean
	optimise: boolean
	withoutOptimisations: Array<string>
}

// One file's problems with its text, as a renderer needs them. A `package.json`
// with an `essence` key has problems too.
export type ProjectProblems = {
	filePath: string
	sourceText: string
	diagnostics: Array<common.Diagnostic>
}

export type ProjectConfiguration = {
	// Null when no project file governs the path, and every setting is at its
	// default.
	filePath: string | null
	// The directory holding the project file, which a run walks. Null exactly
	// when `filePath` is.
	root: string | null
	// Absolute paths no discovery walk descends into. A file named on the
	// command line or open in the editor is still compiled.
	exclude: Array<string>
	test: TestConfiguration
	build: BuildConfiguration
	// What could not be read as a setting, as warnings against its file.
	problems: Array<ProjectProblems>
}

// The one spelling of the defaults, which every unread setting falls back to.
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

// Compared as a path rather than as text, so `fixtures/broken` excludes what
// is under it but not `fixtures/brokenish`.
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

// Every `.es` file under a directory, outside skipped and excluded ones. A
// symlinked directory is not descended into, so a link can not loop the walk.
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
// The catalogue: every setting the file may hold, as data. The reader and
// `projectSchema` both work from it.
// ---------------------------------------------------------------------------

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
	// What is in force when the setting could not be read, which the
	// Diagnostic's note says.
	fallback: string
	// One valid value, spelled as it would be written, for the Help.
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

// The names a `list` holds, for the messages and the Schema.
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

// Generated from the catalogue. Specs compare it with the copies the VS Code
// extension and the website ship.
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

// The setting a flat key such as `"test.cases"` names, as a path from the
// root wherever the key stands. Null for any other key.
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

// The path spelled as nested objects, `"test": { "cases": 200 }`, for the Help.
function nestedSpelling(parts: Array<string>, value: unknown): string {
	return parts.reduceRight(
		(inner, part, index) =>
			index === parts.length - 1
				? `${JSON.stringify(part)}: ${inner}`
				: `${JSON.stringify(part)}: { ${inner} }`,
		JSON.stringify(value),
	)
}

// Names the setting and what was written, spells a right value, and ends on
// what is in force meanwhile.
function wrongShape(
	reading: Reading,
	keyPath: string,
	setting: Setting,
	node: JsonNode,
	written: string = describeNode(node),
): void {
	// The written value in the setting's shape, where it says what was meant.
	// Otherwise the catalogue's example is offered as an example.
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

// The written value read as what the author meant, or null where it says
// nothing, as `"cases": "many"` does. Narrow, since a guess changes the file.
function coercedSettingValue(
	shape: SettingShape,
	node: JsonNode,
): string | null {
	if (shape.kind === "boolean") {
		// `0` and `1` and no other number.
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

		// `Number` rounds past 2^53, which would offer a number nobody wrote.
		if (!Number.isSafeInteger(written)) {
			return null
		}

		return written >= shape.atLeast ? String(written) : null
	}

	// One String is a list of one, whose item the list reader checks later. An
	// empty String means nothing at all, so the example is offered instead.
	if (shape.kind === "list") {
		return node.type === "string" && node.value !== ""
			? JSON.stringify([node.value])
			: null
	}

	return null
}

// A `property` node's key and value. A property with no value parses with one
// child, and gives null.
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

// Read item by item, so one bad item is reported and left out while the rest
// stay in force.
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

// Keys read elsewhere in the file, by where they are now read. Each is
// reported as moved rather than unknown.
const movedSettings: Record<string, string> = {
	"test.exclude": "exclude",
}

// Reads a table's settings into `values`. It is the one place an unknown key
// is reported.
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
				// A flat key is nested, a near miss is renamed, and any other
				// key is removed.
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

// The edit a syntax error names, where it names the missing character. Only
// the first error gets one, since the later ones are about text the recovery
// has lost track of.
function parseErrorHelp(
	error: ParseError,
	first: boolean,
	sourceText: string,
): Array<string> {
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
			return [missingCommaHelp(sourceText, error.offset)]
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

// jsonc asks for a ',' wherever a list or an object goes on unclosed. A ','
// in front of a closer or a key would not read there. So a closer that matches
// no open bracket, or a key inside a list, names the bracket instead.
function missingCommaHelp(sourceText: string, offset: number): string {
	let open = openBracketsAt(sourceText, offset)
	let innermost = open.at(-1)
	let next = sourceText[offset]

	if (innermost === "[" && next === "}") {
		return "Write the ']' that closes the list."
	}

	if (
		innermost === "[" &&
		/^"(?:[^"\\]|\\.)*"\s*:/.test(sourceText.slice(offset))
	) {
		return "Write the ']' that closes the list, and a ',' after it."
	}

	if (innermost === "{" && next === "]") {
		return open.includes("[")
			? "Write the '}' that closes the object."
			: "Write '}' in place of this ']'."
	}

	return "Write the ',' that separates this from the one above it."
}

// The brackets still open at `offset`, outermost first. A bracket inside a
// String or a Comment opens nothing, so both are stepped over.
function openBracketsAt(sourceText: string, offset: number): Array<string> {
	let open: Array<string> = []
	let index = 0

	while (index < offset) {
		let character = sourceText[index]

		if (character === '"') {
			index++

			while (index < offset && sourceText[index] !== '"') {
				index += sourceText[index] === "\\" ? 2 : 1
			}
		} else if (sourceText.startsWith("//", index)) {
			let end = sourceText.indexOf("\n", index)

			index = end === -1 ? offset : end
		} else if (sourceText.startsWith("/*", index)) {
			let end = sourceText.indexOf("*/", index + 2)

			index = end === -1 ? offset : end + 1
		} else if (character === "{" || character === "[") {
			open.push(character)
		} else if (character === "}" || character === "]") {
			open.pop()
		}

		index++
	}

	return open
}

// A syntax error's code as a sentence.
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

// Text in, configuration out, for an unsaved buffer or a spec.
// `readProjectConfiguration` adds the disk.
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

	// An empty file still marks the root. The parse would report the missing
	// value.
	if (sourceText.trim() === "") {
		return configuration
	}

	let errors: Array<ParseError> = []
	let tree = parseTree(sourceText, errors, {
		allowTrailingComma: true,
		disallowComments: false,
	})

	// A file that does not parse leaves every setting at its default, and what
	// did parse is not read.
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
					"The file is JSON with comments and trailing commas allowed, as tsconfig.json is.",
				],
				parseErrorHelp(error, error === errors[0], sourceText),
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
// Editing the file: the smallest change that answers a Diagnostic, made here
// so that the language server needs no second reader of the format.
// ---------------------------------------------------------------------------

export type SettingEdit = {
	code: Extract<
		common.DiagnosticCode,
		"unknown-setting" | "moved-setting" | "setting-shape"
	>
	// The span the Diagnostic was reported at, by which an editor finds it.
	position: common.Position
	// One replacement, since a move changes two places and the text between
	// them is written back unchanged.
	range: common.Position
	newText: string
	// The setting's name once the edit lands, which tells two edits apart.
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

// A property with its key path and its two halves.
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
	// A near miss renames the key, whose span includes its quotes.
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

	// A coerced value rewrites one span: `"false"` becomes `false`, and
	// `"wip"` becomes `["wip"]`.
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

	// A flat key such as `"test.cases"` is moved to the path it spells.
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

	// A `package.json`'s `essence` key has the same code, but moved to another
	// file, so no edit here answers it.
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

// One property out and back in at another path, for a moved key and a flat
// one alike.
function movedPropertyEdit(
	code: SettingEdit["code"],
	position: common.Position,
	sourceText: string,
	tree: JsonNode,
	found: KeyedProperty,
	destination: Array<string>,
	cursorAt: (offset: number) => common.Cursor,
): SettingEdit | null {
	// Withheld where the destination is written, since only one of the two
	// values could survive.
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

// One property removed with its separating comma and its line. By hand, since
// a removal through `modify` takes everything back to the previous sibling,
// comments included.
function withoutProperty(sourceText: string, property: JsonNode): string {
	let start = property.offset
	let end = property.offset + property.length
	let following = /^[ \t]*,/.exec(sourceText.slice(end))

	// The comma in front, and the break after it, go only where the property
	// was last.
	if (following !== null) {
		end += following[0].length
	} else {
		let preceding = /,\s*$/.exec(sourceText.slice(0, start))

		start -= preceding?.[0].length ?? 0
	}

	let lineStart = sourceText.lastIndexOf("\n", start - 1) + 1
	let lineBreak = sourceText.indexOf("\n", end)
	let lineEnd = lineBreak === -1 ? sourceText.length : lineBreak

	// A property on a line of its own takes the line with it.
	if (sourceText.slice(lineStart, start).trim() === "") {
		if (sourceText.slice(end, lineEnd).trim() === "") {
			start = lineStart
			end = lineBreak === -1 ? sourceText.length : lineBreak + 1
		} else {
			// A Comment after it keeps the property's indentation.
			end += /^[ \t]*/.exec(sourceText.slice(end))?.[0].length ?? 0
		}
	}

	return sourceText.slice(0, start) + sourceText.slice(end)
}

// The property holding a table this one is alone in, which the move removes
// too. Null where the table's text holds anything else, a comment included.
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

// How the file indents, read off its first indented line. A file with none
// takes a tab, as `essence init` writes.
function indentationOf(sourceText: string): {
	tabSize: number
	insertSpaces: boolean
} {
	let indented = /\n([ \t]+)\S/.exec(sourceText)?.[1] ?? "\t"

	return indented.startsWith("\t")
		? { tabSize: 1, insertSpaces: false }
		: { tabSize: indented.length, insertSpaces: true }
}

// The two texts reduced to the span they differ in, so nothing outside the
// change is rewritten.
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

// Every property of the document with its key path.
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

// The nearest project file in a directory or its ancestors, or null.
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

// The `package.json` paths from a directory up to the project root, nearest
// first. Without a root, it goes up to the filesystem root.
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

// An `essence` key in a `package.json`, reported as moved on the key.
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

// The configuration governing a directory, for a command that reads once. A
// caller that asks per file holds a `ConfigurationCache`.
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

// A configuration per directory, read once. Directories under one project
// file share one object, so identity says whether two files share settings.
// `clear` runs when a project file changes.
export type ConfigurationCache = {
	forDirectory(directory: string): ProjectConfiguration
	forFile(filePath: string): ProjectConfiguration
	// Every distinct configuration read so far, the default included.
	known(): Array<ProjectConfiguration>
	clear(): void
}

export function createConfigurationCache(): ConfigurationCache {
	let byDirectory = new Map<string, ProjectConfiguration>()
	let unconfigured: ProjectConfiguration | null = null

	// Reports this directory's manifest, once, against the configuration
	// governing the directory.
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
