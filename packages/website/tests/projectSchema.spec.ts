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

// NOTE: The site serves the JSON Schema for `essence.json` at the URL the
// file's `$schema` names, so an editor anywhere can validate a project file
// against what the toolchain actually reads. The copy is generated from the
// reader's catalogue; this spec re-renders and compares, and NEVER writes — a
// drifted copy is fixed by `bun run generate:schema`.
//
// NOTE: Beside the file it holds to account, in the package that ships it,
// rather than in the compiler's tests counting `../`s towards it.
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

// NOTE: The same catalogue, held against the page that documents it. A setting
// the reader gains has no address on the site until the page gives it an entry,
// and an entry for a setting the reader dropped documents a key that is now a
// Warning — so both directions fail here.
//
// NOTE: The catalogue's keys the page gives no entry of its own. `test.contracts`
// switches an experimental test mode, which the site documents nowhere.
// `$schema` is not a setting — Essence reads nothing from it — and the page
// says so under "The file format" rather than beside the settings.
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

// NOTE: The address a `###` is reached by. A dotted key cannot be its own
// heading's slug — the slugger drops the dots — so the page writes the address
// in a `<span id>` inside the heading. A key without a dot is the heading's own
// text, and its slug is the address.
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

// NOTE: The file a page shows `essence init` writing: the first `jsonc` fence
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
		// NOTE: A named exception outlives the key it excused otherwise, and
		// then silently excuses whatever is next given that name.
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
