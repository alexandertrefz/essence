import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"

import { spawnAndWait } from "@essence-lang/fixtures/spawn"

import {
	type Manifest,
	packageDirectory,
	PUBLISHED_PACKAGES,
	REPOSITORY_ROOT,
} from "../publishing/packages"

// NOTE: The workspace resolves every `@essence-lang/*` package from the root
// `node_modules`, declared or not, but a package installed on its own finds only
// what its manifest names: the nearest tracked `package.json` above the file.

type Token = {
	kind: "word" | "string" | "punctuation"
	text: string
	line: number
}

// NOTE: After one of these words a `/` opens a regular expression; after any
// other word it divides.
const regexpAfterWords = new Set([
	"return",
	"typeof",
	"case",
	"do",
	"else",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"instanceof",
	"yield",
	"await",
])

// NOTE: The words, Strings and punctuation of a script. Comments are skipped,
// and a template or a regular expression is skipped whole apart from the code in
// a template's holes, so text inside any of them never reads as an import.
function tokensOf(source: string): Array<Token> {
	let tokens: Array<Token> = []
	let index = 0
	let line = 1
	// NOTE: The brace depth each open template hole returns to its template at.
	let holes: Array<number> = []
	let depth = 0
	let afterValue = false

	let skipEscape = () => {
		if (source[index + 1] === "\n") {
			line++
		}

		index += 2
	}

	let template = () => {
		while (index < source.length) {
			let character = source[index]!

			if (character === "\\") {
				skipEscape()

				continue
			}

			if (character === "\n") {
				line++
			}

			if (character === "`") {
				index++

				return
			}

			if (character === "$" && source[index + 1] === "{") {
				index += 2
				holes.push(depth)

				return
			}

			index++
		}
	}

	if (source.startsWith("#!")) {
		index = source.indexOf("\n")
		index = index === -1 ? source.length : index
	}

	while (index < source.length) {
		let character = source[index]!
		let next = source[index + 1]

		if (character === "\n") {
			line++
			index++

			continue
		}

		if (/\s/.test(character)) {
			index++

			continue
		}

		if (character === "/" && next === "/") {
			let end = source.indexOf("\n", index)
			index = end === -1 ? source.length : end

			continue
		}

		if (character === "/" && next === "*") {
			let end = source.indexOf("*/", index + 2)
			end = end === -1 ? source.length : end
			line += source.slice(index, end).split("\n").length - 1
			index = end + 2

			continue
		}

		if (character === '"' || character === "'") {
			let start = line
			let text = ""
			index++

			while (
				index < source.length &&
				source[index] !== character &&
				source[index] !== "\n"
			) {
				if (source[index] === "\\") {
					text += source.slice(index, index + 2)
					skipEscape()
				} else {
					text += source[index]
					index++
				}
			}

			index++
			tokens.push({ kind: "string", text, line: start })
			afterValue = true

			continue
		}

		if (character === "`") {
			index++
			template()
			afterValue = true

			continue
		}

		if (character === "}" && holes.at(-1) === depth) {
			holes.pop()
			index++
			template()
			afterValue = true

			continue
		}

		if (character === "/" && !afterValue) {
			let end = index + 1
			let inClass = false

			while (end < source.length && source[end] !== "\n") {
				let inside = source[end]!

				if (inside === "\\") {
					end += 2

					continue
				}

				if (inside === "/" && !inClass) {
					break
				}

				inClass =
					inside === "[" ? true : inside === "]" ? false : inClass
				end++
			}

			// NOTE: A line that never closes it was a division after all.
			if (source[end] === "/") {
				index = end + 1

				while (index < source.length && /[a-z]/.test(source[index]!)) {
					index++
				}

				afterValue = true

				continue
			}
		}

		if (/[A-Za-z_$]/.test(character)) {
			let end = index + 1

			while (end < source.length && /[\w$]/.test(source[end]!)) {
				end++
			}

			let word = source.slice(index, end)
			tokens.push({ kind: "word", text: word, line })
			afterValue = !regexpAfterWords.has(word)
			index = end

			continue
		}

		if (/[0-9]/.test(character)) {
			while (index < source.length && /[\w.]/.test(source[index]!)) {
				index++
			}

			afterValue = true

			continue
		}

		if (character === "{") {
			depth++
		} else if (character === "}") {
			depth--
		}

		tokens.push({ kind: "punctuation", text: character, line })
		afterValue = character === ")" || character === "]"
		index++
	}

	return tokens
}

type Import = { specifier: string; line: number }

// NOTE: Every form that names a module to load: `import … from`,
// `export … from`, a bare `import "x"`, `import("x")` in code or in a type,
// `require("x")` and `import.meta.resolve("x")`.
function importsOf(source: string): Array<Import> {
	let tokens = tokensOf(source)
	let imports: Array<Import> = []

	let at = (index: number, kind: Token["kind"], text: string) =>
		tokens[index]?.kind === kind && tokens[index]!.text === text
	let word = (index: number, text: string) =>
		at(index, "word", text) && !at(index - 1, "punctuation", ".")

	for (let [index, token] of tokens.entries()) {
		if (token.kind !== "string") {
			continue
		}

		let called = at(index - 1, "punctuation", "(")

		if (
			word(index - 1, "from") ||
			word(index - 1, "import") ||
			(called && word(index - 2, "import")) ||
			(called && word(index - 2, "require")) ||
			(called &&
				at(index - 2, "word", "resolve") &&
				at(index - 3, "punctuation", ".") &&
				at(index - 4, "word", "meta") &&
				at(index - 5, "punctuation", ".") &&
				at(index - 6, "word", "import"))
		) {
			imports.push({ specifier: token.text, line: token.line })
		}
	}

	return imports
}

// NOTE: An Astro component's script is its frontmatter and its `<script>`
// elements. Everything else is blanked, keeping its line breaks so that lines
// are counted as the file counts them.
function astroScript(source: string): string {
	let script = source.replace(/[^\n]/g, " ").split("")
	let frontmatter = /^---\r?\n([\s\S]*?)\r?\n---$/dm.exec(source)
	let regions = [
		...(frontmatter?.index === 0 ? [frontmatter] : []),
		...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/dg),
	]

	for (let region of regions) {
		let [start, end] = region.indices![1]!

		for (let index = start; index < end; index++) {
			script[index] = source[index]!
		}
	}

	return script.join("")
}

// NOTE: The script a tracked file holds, or `null` for a file that is not one.
// A `bin/` command is a script without an extension, known by its shebang.
function scriptOf(file: string, text: string): string | null {
	if (/\.[cm]?[jt]sx?$/.test(file)) {
		return text
	}

	if (file.endsWith(".astro")) {
		return astroScript(text)
	}

	if (!path.basename(file).includes(".") && text.startsWith("#!")) {
		return text
	}

	return null
}

const essencePackage = /^@essence-lang\/[^/]+/

type Owned = {
	file: string
	line: number
	specifier: string
	name: string
	owner: string
	manifest: Manifest
}

type Repository = {
	fileCount: number
	imports: Array<Owned>
}

let repository: Repository | null = null

async function readRepository(): Promise<Repository> {
	if (repository !== null) {
		return repository
	}

	let listed = await spawnAndWait(["git", "ls-files", "-z"], {
		cwd: REPOSITORY_ROOT,
	})

	if (listed.code !== 0) {
		throw new Error(`git ls-files failed: ${listed.stderr}`)
	}

	let files = listed.stdout.split("\0").filter((file) => file !== "")
	let manifests = new Map<string, Manifest>()

	for (let file of files) {
		if (path.basename(file) === "package.json") {
			manifests.set(
				path.dirname(file),
				JSON.parse(
					readFileSync(path.join(REPOSITORY_ROOT, file), "utf8"),
				) as Manifest,
			)
		}
	}

	let ownerOf = (file: string): string => {
		let directory = path.dirname(file)

		while (!manifests.has(directory) && directory !== ".") {
			directory = path.dirname(directory)
		}

		return directory
	}

	let imports: Array<Owned> = []
	let fileCount = 0

	for (let file of files) {
		let absolute = path.join(REPOSITORY_ROOT, file)

		if (!existsSync(absolute)) {
			continue
		}

		let script = scriptOf(file, readFileSync(absolute, "utf8"))

		if (script === null) {
			continue
		}

		fileCount++

		let owner = ownerOf(file)

		for (let { specifier, line } of importsOf(script)) {
			let name = essencePackage.exec(specifier)?.[0]

			if (name !== undefined) {
				imports.push({
					file,
					line,
					specifier,
					name,
					owner: path.join(owner, "package.json"),
					manifest: manifests.get(owner)!,
				})
			}
		}
	}

	repository = { fileCount, imports }

	return repository
}

// NOTE: What `tsconfig.publish.json` compiles and staging copies: a published
// package's `src/` apart from its tests and tools, and its `bin/` commands.
function isShipped(file: string): boolean {
	return PUBLISHED_PACKAGES.some(({ directory, prebuilt }) => {
		let root = path.relative(REPOSITORY_ROOT, packageDirectory(directory))

		if (prebuilt !== undefined) {
			return prebuilt.some((shipped) => file === `${root}/${shipped}`)
		}

		if (file.startsWith(`${root}/bin/`)) {
			return true
		}

		return (
			file.startsWith(`${root}/src/`) &&
			!/\/(?:tests|tools)\//.test(file) &&
			!file.endsWith(".spec.ts")
		)
	})
}

describe("the @essence-lang imports", () => {
	describe("importsOf", () => {
		it("finds each form an import is written in", () => {
			let source = [
				'import { a } from "@essence-lang/a"',
				'import type { B } from "@essence-lang/b"',
				'export * from "@essence-lang/c"',
				'import "@essence-lang/d"',
				'let e = await import("@essence-lang/e")',
				'let f: typeof import("@essence-lang/f") = e',
				'let g = require("@essence-lang/g")',
				'let h = import.meta.resolve("@essence-lang/h")',
			].join("\n")

			expect(importsOf(source)).toEqual(
				["a", "b", "c", "d", "e", "f", "g", "h"].map((name, index) => ({
					specifier: `@essence-lang/${name}`,
					line: index + 1,
				})),
			)
		})

		it("finds no import in a comment, a String or a template", () => {
			let source = [
				'// import { a } from "@essence-lang/a"',
				'/* export * from "@essence-lang/b" */',
				"let c = 'await import(\"@essence-lang/c\")'",
				'let d = `import.meta.resolve("@essence-lang/d") ${c}`',
				'let e = format.import("@essence-lang/e")',
			].join("\n")

			expect(importsOf(source)).toEqual([])
		})

		it("reads past a regular expression that holds a quote", () => {
			let source = 'let quote = /"/g, a = await import("@essence-lang/a")'

			expect(importsOf(source)).toEqual([
				{ specifier: "@essence-lang/a", line: 1 },
			])
		})

		it("reads an Astro component's frontmatter and scripts", () => {
			let source = [
				"---",
				'import { a } from "@essence-lang/a"',
				"---",
				'<p>import { b } from "@essence-lang/b"</p>',
				"<script>",
				'import { c } from "@essence-lang/c"',
				"</script>",
			].join("\n")

			expect(importsOf(scriptOf("A.astro", source)!)).toEqual([
				{ specifier: "@essence-lang/a", line: 2 },
				{ specifier: "@essence-lang/c", line: 6 },
			])
		})
	})

	// NOTE: The checks that follow pass on an empty list, so a scanner that
	// read no file, or found no import in the files it read, would pass them
	// all unnoticed.
	it("finds imports to check", async () => {
		let { fileCount, imports } = await readRepository()

		expect(fileCount).toBeGreaterThan(500)
		expect(imports.length).toBeGreaterThan(400)
	})

	it("declares each package a package imports", async () => {
		let { imports } = await readRepository()
		let findings = imports
			.filter(
				({ name, manifest }) =>
					name !== manifest.name &&
					manifest.dependencies?.[name] === undefined &&
					manifest.devDependencies?.[name] === undefined,
			)
			.map(
				({ file, line, specifier, owner }) =>
					`${file}:${line}: ${owner} does not declare ${specifier}`,
			)

		expect(findings.join("\n")).toBe("")
	})

	// NOTE: A published package is installed without its `devDependencies`, so
	// what its shipped code loads has to be one of its `dependencies`.
	it("depends on each package a published package's shipped code imports", async () => {
		let { imports } = await readRepository()
		let findings = imports
			.filter(
				({ file, name, manifest }) =>
					isShipped(file) &&
					name !== manifest.name &&
					manifest.dependencies?.[name] === undefined,
			)
			.map(
				({ file, line, specifier, owner }) =>
					`${file}:${line}: ${specifier} is not among the dependencies of ${owner}`,
			)

		expect(findings.join("\n")).toBe("")
	})
})
