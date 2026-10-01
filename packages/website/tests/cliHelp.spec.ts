import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import * as path from "node:path"

import { commands } from "@essence-lang/cli/src/commands.ts"
import {
	renderCommandHelp,
	renderOverview,
} from "@essence-lang/cli/src/help.ts"
import { createPalette, createTheme } from "@essence-lang/cli/src/theme.ts"

/*
 * The command-line reference, held to the screens `essence help <command>`
 * prints. Every listed flag has an entry at
 * `/docs/reference/cli#<command>--<flag>`, which guides link to, and every
 * entry documents a listed flag.
 *
 * Only the rendered screen's OPTIONS and GLOBAL OPTIONS sections are read,
 * since descriptions and examples mention flags in passing. The screen is what
 * a reader compares the page with, and it omits hidden flags.
 */

const CLI_PAGE = path.resolve(
	import.meta.dirname,
	"../src/content/docs/reference/cli.mdx",
)

// The flags only the experimental test modes take. The site documents none of
// those modes, so these are neither required nor allowed on the page.
const EXPERIMENTAL_FLAGS = new Set([
	"bench",
	"contracts",
	"no-contracts",
	"mutate",
	"mutation-limit",
	"strict",
])

// Hidden from every screen but documented beside the flag it undoes, since
// `--no-color` keeps colour codes out of a file.
const DOCUMENTED_HIDDEN_FLAGS = new Set(["no-color"])

const GLOBAL = "global"

let context = {
	palette: createPalette(createTheme(false, true)),
	width: 88,
	version: "0.0.0",
	programName: "essence",
}

/** The long names a screen's section lists, one per row. */
function flagsUnder(screen: string, title: string): Array<string> {
	let lines = screen.split("\n")
	let start = lines.indexOf(`  ${title}`)

	if (start === -1) {
		return []
	}

	let flags: Array<string> = []

	for (let line of lines.slice(start + 1)) {
		// The next section's heading ends this one.
		if (/^ {2}[A-Z][A-Z ]*$/.test(line)) {
			break
		}

		// A row opens four spaces in, with its short flag or four spaces for a
		// missing one. An option's description is indented further.
		let row = /^ {4}(?:-[A-Za-z], | {4})?--([a-z][a-z-]*)/.exec(line)

		if (row !== null) {
			flags.push(row[1] as string)
		}
	}

	return flags
}

/** Every flag the screens list, by the address the page gives it. */
function printedAddresses(): Map<string, string> {
	let addresses = new Map<string, string>()

	for (let command of commands) {
		let screen = renderCommandHelp(command, context)

		for (let flag of flagsUnder(screen, "OPTIONS")) {
			addresses.set(
				`${command.name}--${flag}`,
				`essence help ${command.name}`,
			)
		}

		for (let flag of flagsUnder(screen, "GLOBAL OPTIONS")) {
			addresses.set(`${GLOBAL}--${flag}`, "GLOBAL OPTIONS")
		}
	}

	return addresses
}

type Entry = {
	id: string
	/** The `##` the entry stands under: a command's name, or `Global options`. */
	section: string
	/** Every `--flag` the heading itself names. */
	named: Array<string>
}

function pageEntries(): Array<Entry> {
	let entries: Array<Entry> = []
	let section = ""

	for (let line of readFileSync(CLI_PAGE, "utf8").split("\n")) {
		let heading = /^## (.+)$/.exec(line)

		if (heading !== null) {
			section = heading[1] as string

			continue
		}

		let entry = /^### <span id="([^"]+)">(.*)<\/span>$/.exec(line)

		if (entry !== null) {
			entries.push({
				id: entry[1] as string,
				section,
				named: [
					...(entry[2] as string).matchAll(/`--([a-z][a-z-]*)/g),
				].map((match) => match[1] as string),
			})
		}
	}

	return entries
}

function flagOf(address: string): string {
	return address.slice(address.indexOf("--") + 2)
}

describe("the command-line reference", () => {
	let printed = printedAddresses()
	let entries = pageEntries()

	it("reads the screens and the page", () => {
		// A guard on both readers: a section title or heading shape that
		// stopped matching would make every other check vacuous.
		expect(printed.size).toBeGreaterThan(30)
		expect(entries.length).toBeGreaterThan(30)
	})

	it("has an entry for every flag a screen lists", () => {
		let ids = new Set(entries.map((entry) => entry.id))
		let missing = [...printed.keys()].filter(
			(address) =>
				!EXPERIMENTAL_FLAGS.has(flagOf(address)) && !ids.has(address),
		)

		expect(missing).toEqual([])
	})

	it("has no entry for a flag no screen lists", () => {
		let addresses = new Set(
			entries.flatMap((entry) => [
				entry.id,
				...entry.named.map(
					(flag) =>
						`${entry.id.slice(0, entry.id.indexOf("--"))}--${flag}`,
				),
			]),
		)
		let stale = [...addresses].filter(
			(address) =>
				!printed.has(address) &&
				!DOCUMENTED_HIDDEN_FLAGS.has(flagOf(address)),
		)

		expect(stale).toEqual([])
	})

	it("documents no experimental flag", () => {
		expect(
			entries.filter((entry) => EXPERIMENTAL_FLAGS.has(flagOf(entry.id))),
		).toEqual([])
	})

	it("files every entry under the section of the command that takes it", () => {
		let misfiled = entries.filter((entry) => {
			let scope = entry.id.slice(0, entry.id.indexOf("--"))

			return scope === GLOBAL
				? entry.section !== "Global options"
				: entry.section !== scope
		})

		expect(misfiled).toEqual([])
	})

	it("has a section for every command", () => {
		let sections = new Set(
			[...readFileSync(CLI_PAGE, "utf8").matchAll(/^## (.+)$/gm)].map(
				(section) => section[1] as string,
			),
		)

		expect(
			commands
				.map((command) => command.name)
				.filter((name) => !sections.has(name)),
		).toEqual([])
	})
})

// A reader types the addresses a screen prints. So each names the site's real
// host, and a page the site builds or a redirect `netlify.toml` serves.
describe("the addresses the help screens print", () => {
	const SITE = "https://essencelang.org"
	const DOCS_DIRECTORY = path.resolve(
		import.meta.dirname,
		"../src/content/docs",
	)
	const NETLIFY = path.resolve(import.meta.dirname, "../../../netlify.toml")

	let redirects = new Map(
		[
			...readFileSync(NETLIFY, "utf8").matchAll(
				/from = "([^"]+)"\s+to = "([^"]+)"/g,
			),
		].map((match) => [match[1] as string, match[2] as string]),
	)

	function isPage(pathname: string): boolean {
		let target = redirects.get(pathname) ?? pathname
		let id = target.replace(/^\/docs\//, "").replace(/\/$/, "")

		return (
			target.startsWith("/docs/") &&
			existsSync(path.join(DOCS_DIRECTORY, `${id}.mdx`))
		)
	}

	let screens = [
		renderOverview(context),
		...commands.map((command) => renderCommandHelp(command, context)),
	]
	let addresses = [
		...new Set(
			screens.flatMap((screen) =>
				[
					...screen.matchAll(
						/\b(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:org|com|dev|io|net)\b[^\s]*/g,
					),
				].map((match) => match[0].replace(/[.,;:)]+$/, "")),
			),
		),
	]

	it("prints at least the address of the optimisation passes", () => {
		expect(addresses).toContain(`${SITE}/docs/reference/optimisations`)
	})

	it("names only pages the site has, on the site's own host", () => {
		expect(
			addresses.filter(
				(address) =>
					!address.startsWith(`${SITE}/`) ||
					!isPage(address.slice(SITE.length)),
			),
		).toEqual([])
	})
})
