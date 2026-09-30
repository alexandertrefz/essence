import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"

import { spawnAndWait } from "@essence-lang/fixtures/spawn"

import type { Citation } from "./commentProse"
import { REPOSITORY_ROOT } from "./publishing/packages"

// Resolves each citation that `scripts/commentProse.ts` reads to a heading in
// the development notes it points to, and keeps each file's headings apart.

export type Heading = {
	text: string
	line: number
}

// Reads a file of notes by its path from the repository root, or answers null
// when there is none.
export type Reader = (file: string) => string | null

const fencePattern = /^ {0,3}(?:```|~~~)/

const headingPattern = /^ {0,3}#{1,6}(?:[ \t]+(.*))?$/

export function headingsOf(markdown: string): Array<Heading> {
	let headings: Array<Heading> = []
	let fenced = false

	for (let [index, line] of markdown.split("\n").entries()) {
		if (fencePattern.test(line)) {
			fenced = !fenced

			continue
		}

		let match = fenced ? null : headingPattern.exec(line)

		if (match !== null) {
			let text = (match[1] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "")

			headings.push({ text: text.trim(), line: index + 1 })
		}
	}

	return headings
}

function directoryOf(file: string): string {
	return path.posix.dirname(file)
}

function developmentIn(directory: string): string {
	return directory === "." ? "DEVELOPMENT.md" : `${directory}/DEVELOPMENT.md`
}

export function nearestDevelopment(file: string, read: Reader): string | null {
	for (
		let directory = directoryOf(file);
		;
		directory = directoryOf(directory)
	) {
		if (read(developmentIn(directory)) !== null) {
			return developmentIn(directory)
		}

		if (directory === ".") {
			return null
		}
	}
}

// What is wrong with a citation, or null when its heading is where it points.
export function problemOf(citation: Citation, read: Reader): string | null {
	let where = `${citation.file}:${citation.line}`
	let cited = `"${citation.heading}"`
	let target = citation.path ?? nearestDevelopment(citation.file, read)

	if (target === null) {
		return `${where}: cites ${cited}, but no DEVELOPMENT.md stands in ${directoryOf(citation.file)} or any directory up to the repository root`
	}

	let markdown = read(target)

	if (markdown === null) {
		return `${where}: cites ${cited} in ${target}, which does not exist`
	}

	if (
		!headingsOf(markdown).some(
			(heading) => heading.text === citation.heading,
		)
	) {
		return `${where}: cites ${cited}, which is not a heading in ${target}`
	}

	return null
}

// A heading text written twice, which a citation could not tell apart.
export function repeatedHeadingsOf(
	file: string,
	markdown: string,
): Array<string> {
	let first = new Map<string, number>()
	let repeated: Array<string> = []

	for (let heading of headingsOf(markdown)) {
		let earlier = first.get(heading.text)

		if (earlier === undefined) {
			first.set(heading.text, heading.line)
		} else {
			repeated.push(
				`${file}:${heading.line}: repeats the heading "${heading.text}" of line ${earlier}`,
			)
		}
	}

	return repeated
}

// Untracked files count too, so new notes are checked before they are added.
export async function developmentFiles(): Promise<Array<string>> {
	let listed = await spawnAndWait(
		["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: REPOSITORY_ROOT },
	)

	if (listed.code !== 0) {
		throw new Error(`git ls-files failed: ${listed.stderr}`)
	}

	return [
		...new Set(
			listed.stdout
				.split("\0")
				.filter(
					(file) => path.posix.basename(file) === "DEVELOPMENT.md",
				),
		),
	].sort()
}

export function readDevelopment(file: string): string | null {
	let absolute = path.join(REPOSITORY_ROOT, file)

	return existsSync(absolute) ? readFileSync(absolute, "utf8") : null
}
