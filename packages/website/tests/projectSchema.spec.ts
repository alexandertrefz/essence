import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

import { projectFileTemplate } from "@essence-lang/cli/src/init.ts"
import {
	projectSchema,
	projectSettings,
	type Setting,
} from "@essence-lang/compiler/configuration"
import GithubSlugger from "github-slugger"

// The site serves the JSON Schema for `essence.json` at the URL its `$schema`
// names, so editors validate against what the toolchain reads. This spec
// re-renders the copy and compares, never writing; `bun run generate:schema`
// fixes a drifted copy.
const SERVED_COPY = path.resolve(
	import.meta.dirname,
	"../public/schemas/essence.schema.json",
)

const DOCS_DIRECTORY = path.resolve(import.meta.dirname, "../src/content/docs")
const PROJECT_FILE_PAGE = path.join(
	DOCS_DIRECTORY,
	"reference/project-file.mdx",
)
const PROJECTS_GUIDE = path.join(DOCS_DIRECTORY, "guides/projects.mdx")

describe("the served project-file Schema", () => {
	it("is in sync with the reader's catalogue", () => {
		let rendered = `${JSON.stringify(projectSchema(), null, "\t")}\n`
		let served = readFileSync(SERVED_COPY, "utf8")

		if (served !== rendered) {
			throw new Error(
				"public/schemas/essence.schema.json is out of date. Run `bun run generate:schema` to regenerate it.",
			)
		}

		expect(JSON.parse(served).$id).toBe(
			"https://essencelang.org/schemas/essence.schema.json",
		)
	})
})

// The catalogue's keys the settings page has no entry for: `test.contracts`
// switches an undocumented experimental mode, and `$schema` is no setting. Every
// other key needs an entry, and every entry a key.
const UNDOCUMENTED_KEYS = new Set(["$schema", "test.contracts"])

/** Every setting a project file can hold, by its dotted path. A table is not a setting; its members are. */
function settingKeys(setting: Setting, prefix = ""): Array<string> {
	if (setting.shape.kind !== "table") {
		return [prefix]
	}

	return Object.entries(setting.shape.members).flatMap(([name, member]) =>
		settingKeys(member, prefix === "" ? name : `${prefix}.${name}`),
	)
}

// The address a `###` is reached by. The slugger drops dots, so a dotted key's
// address is a `<span id>` inside its heading. Otherwise the slug is the
// address.
function entryIds(page: string): Array<string> {
	let slugger = new GithubSlugger()

	return [...page.matchAll(/^### (.+)$/gm)].map((match) => {
		let heading = match[1] as string
		let span = /^<span id="([^"]+)">/.exec(heading)

		return span === null
			? slugger.slug(heading.replaceAll("`", ""))
			: (span[1] as string)
	})
}

// The file a page shows `essence init` writing: the first `jsonc` fence
// after the transcript that runs the command.
function initBlock(page: string): string {
	let command = page.indexOf("$ essence init")
	let fence = command === -1 ? -1 : page.indexOf("```jsonc\n", command)

	if (fence === -1) {
		throw new Error("Could not find the file `essence init` writes")
	}

	let start = fence + "```jsonc\n".length

	return page.slice(start, page.indexOf("```", start))
}

describe("the project-file reference", () => {
	let page = readFileSync(PROJECT_FILE_PAGE, "utf8")

	it("has one entry per setting, under the setting's address", () => {
		let expected = settingKeys(projectSettings)
			.filter((key) => !UNDOCUMENTED_KEYS.has(key))
			.map((key) => key.replaceAll(".", "-"))

		expect(entryIds(page).sort()).toEqual(expected.sort())
	})

	it("leaves out only keys the catalogue still has", () => {
		// An exception must name a real key, or it would silently excuse the
		// next key given that name.
		let keys = new Set(settingKeys(projectSettings))

		expect([...UNDOCUMENTED_KEYS].filter((key) => !keys.has(key))).toEqual(
			[],
		)
	})
})

describe("the file `essence init` writes, as the pages show it", () => {
	it("is the template on the project-file reference", () => {
		expect(initBlock(readFileSync(PROJECT_FILE_PAGE, "utf8"))).toBe(
			projectFileTemplate(),
		)
	})

	it("is the template on the Projects guide", () => {
		expect(initBlock(readFileSync(PROJECTS_GUIDE, "utf8"))).toBe(
			projectFileTemplate(),
		)
	})
})
