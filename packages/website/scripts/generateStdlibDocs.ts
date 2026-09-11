/*
 * Turns the standard library's declared surface into documentation pages.
 *
 *   bun scripts/generateStdlibDocs.ts          create what is missing
 *   bun scripts/generateStdlibDocs.ts --sync   also refresh generated frontmatter
 *
 * ── What it will and will not touch ───────────────────────────────────────
 *
 * It CREATES a page that does not exist yet and otherwise leaves the file
 * alone. Every page here is meant to be written on afterwards — the generated
 * body is a floor, not a ceiling — and a generator that rewrote bodies would
 * make that work disposable.
 *
 * `--sync` is the exception, and it goes no further than the frontmatter block:
 * a signature that changed in the sources is a fact about the language, not a
 * decision the page's author made, and it has to be able to travel. Prose below
 * the frontmatter is never touched by anything here.
 *
 * ── Why generated at all ──────────────────────────────────────────────────
 *
 * Because the alternative is 179 pages that fall out of date one at a time,
 * silently, and a reference that lies is worse than no reference. The gate in
 * `tests/stdlibMembers.spec.ts` is the other half: it fails when a Member has no
 * page, so adding a Method to the standard library breaks the build until the
 * page exists — the same bargain `diagnosticCodes.spec.ts` already strikes for
 * Diagnostic codes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"

import { type Member, type Namespace, readSurface } from "./stdlibSurface.ts"

/*
 * The published types, in the order the sidebar shows them: the numeric tower
 * first, widest last, then the everyday containers, then the small choice types
 * that only exist as arguments to the Methods above.
 *
 * A closed list rather than whatever the sources happen to declare, for the
 * reason `SECTIONS` is one in `navigation.ts` — this is running order, and a
 * Namespace that appears in the standard library without appearing here should
 * stop the build and be given a place, not be appended wherever it landed.
 *
 * `order` leaves gaps so a hand-written page can be slotted between two of
 * these without renumbering the rest.
 */
interface TypeEntry {
	namespace: string
	slug: string
	order: number
	/** The type page's own lede. */
	description: string
}

const TYPES: TypeEntry[] = [
	{
		namespace: "Integer",
		slug: "integer",
		order: 10,
		description:
			"Whole numbers of arbitrary size, exact and without a width to overflow.",
	},
	{
		namespace: "NonZeroInteger",
		slug: "non-zero-integer",
		order: 15,
		description:
			"An Integer the compiler has checked is not zero — `Integer where @::isNot(0)`, which is what a divisor has to be.",
	},
	{
		namespace: "Rational",
		slug: "rational",
		order: 20,
		description:
			"Exact ratios of two Integers, always in lowest terms — a tenth is a tenth.",
	},
	{
		namespace: "Algebraic",
		slug: "algebraic",
		order: 30,
		description:
			"Numbers of the form a + b·√d, so a square root stays a square root rather than a decimal that is nearly one.",
	},
	{
		namespace: "Transcendental",
		slug: "transcendental",
		order: 40,
		description:
			"Numbers of the form a + b·π, carried exactly through arithmetic that would otherwise round them away.",
	},
	{
		namespace: "Number",
		slug: "number",
		// Before its own cases rather than after them: it is the union they are
		// cases of, and the rail nests them under it.
		order: 5,
		description:
			"The four exact types as one union, and the arithmetic that spans them — comparison, aggregates, and the constants.",
	},
	{
		namespace: "Boolean",
		slug: "boolean",
		order: 60,
		description:
			"The two truth values and the logic that combines them. Nothing else is ever true or false.",
	},
	{
		namespace: "String",
		slug: "string",
		order: 70,
		description:
			"Text, measured and sliced in characters rather than in bytes or code units.",
	},
	{
		namespace: "List",
		slug: "list",
		order: 80,
		description:
			"The ordered sequence. Every Method answers with a new List; none of them changes the one it was asked.",
	},
	{
		namespace: "NonEmptyList",
		slug: "non-empty-list",
		order: 85,
		description:
			"A List the compiler has checked has something in it — `List where @::hasItems()`, which is what lets `firstItem` answer an item rather than an Optional.",
	},
	{
		namespace: "Optional",
		slug: "optional",
		order: 90,
		description:
			"A value that might not be there — a choice between #Value and #Empty rather than a null anybody could forget to check.",
	},
	{
		namespace: "Record",
		slug: "record",
		order: 100,
		description:
			"Structural data: two Records with the same fields are the same type, with nothing to declare first.",
	},
	{
		namespace: "Ordering",
		slug: "ordering",
		order: 120,
		description: "The answer a comparison gives: before, same, or after.",
	},
	{
		namespace: "Case",
		slug: "case",
		order: 130,
		description:
			"Whether a String comparison treats upper and lower case as the same.",
	},
	{
		namespace: "Side",
		slug: "side",
		order: 140,
		description: "Which end of a String an operation works from.",
	},
	{
		namespace: "NormalizationForm",
		slug: "normalization-form",
		order: 150,
		description:
			"Which Unicode normalization form a String is measured or compared in.",
	},
	{
		namespace: "NumberFormat",
		slug: "number-format",
		order: 160,
		description: "How a number is rendered when it becomes text.",
	},
	{
		namespace: "Rounding",
		slug: "rounding",
		order: 165,
		description:
			"Which way a Rational goes when it is asked for a whole number.",
	},
	{
		namespace: "Terminal",
		slug: "terminal",
		// Last, and alone: the one namespace that is a capability rather than a
		// type — where a program's output goes, not a value it holds.
		order: 170,
		description:
			"Everything a program can put in front of a person: print for the reader, inspect for the author, and write, the exact-text primitive beneath both.",
	},
]

/*
 * `NestedList` exists because no bound can say "the items are themselves Lists"
 * and still name the inner item type, so `flatten` had to be declared on a
 * Namespace of its own. That is a fact about what the type system can express,
 * not a second type a reader has to learn, so its Members are published on
 * `List` where somebody would look for them.
 */
const MERGED_INTO: Record<string, string> = {
	NestedList: "List",
	NestedOptional: "Optional",
}

/*
 * Which type page sits under which, in the sidebar.
 *
 * Read off the standard library's own `type X = A | B` aliases: `Number` is
 * declared as `Integer | Rational | Algebraic | Transcendental`, so those four
 * are its cases and the rail shows them under it. Derived rather than listed
 * here, because the alias is the fact — a tower that grows a case grows the
 * navigation with it, and one that loses a case cannot leave a stale row behind.
 *
 * An alias only counts when every one of its cases has a page of its own.
 * `Irrational` is a union of two published types but has no page to hang them
 * from, so it must not quietly restructure the sidebar.
 */
function nesting(
	aliases: Array<{ name: string; cases: string[] }>,
	published: Set<string>,
): Map<string, string> {
	let parents = new Map<string, string>()

	for (let alias of aliases) {
		if (
			!published.has(alias.name) ||
			alias.cases.length === 0 ||
			!alias.cases.every((name) => published.has(name))
		) {
			continue
		}

		for (let name of alias.cases) {
			let existing = parents.get(name)

			if (existing !== undefined && existing !== alias.name) {
				throw new Error(
					`${name} is a case of both ${existing} and ${alias.name}; the sidebar can only nest it under one, so which is a decision that has to be written down here.`,
				)
			}

			parents.set(name, alias.name)
		}
	}

	return parents
}

const DOCS = path.resolve(import.meta.dirname, "../src/content/docs")
const SECTION = "standard-library"

let sync = process.argv.includes("--sync")

/** `isLessThanOrEqualTo` → `is-less-than-or-equal-to`. */
function slugify(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.toLowerCase()
}

/*
 * How a Member is written at a call site, which is what a reader is looking for
 * when they scan a list of them: `2::add(3)` for a Method, `Integer.parse("2")`
 * for a static one. The two are not interchangeable in essence, so the title is
 * not either.
 */
function memberTitle(namespace: string, member: Member): string {
	return member.kind === "method"
		? `${namespace}::${member.name}`
		: `${namespace}.${member.name}`
}

/** One line, no newlines: this also lands in `<meta>` and in the search index. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}

/*
 * A brace outside a code span opens an expression in MDX, and a doc comment
 * that shows a Record — `{ x = 1 }` — would be read as one and fail the build.
 * Inside a span it is already inert, so only the text between spans is escaped.
 */
function escapeMdx(text: string): string {
	return text
		.split(/(`[^`]*`)/)
		.map((part, index) =>
			index % 2 === 1 ? part : part.replace(/([{}])/g, "\\$1"),
		)
		.join("")
}

function frontmatter(fields: Array<[string, string]>): string {
	return `---\n${fields.map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n`
}

/** YAML-safe on one line, whatever punctuation the summary happens to carry. */
function quoted(text: string): string {
	return JSON.stringify(oneLine(text))
}

function memberFrontmatter(
	type: TypeEntry,
	member: Member,
	declaringNamespace: string,
): string {
	return frontmatter([
		["title", quoted(memberTitle(declaringNamespace, member))],
		["description", quoted(member.summary)],
		["section", SECTION],
		["order", String(member.order)],
		["template", "reference"],
		["kind", quoted(member.kind)],
		["monoTitle", "true"],
		["namespace", quoted(declaringNamespace)],
		["member", quoted(member.name)],
		[
			"signature",
			// A YAML block scalar: two spaces of indentation, and the tabs the
			// signature itself carries survive inside it untouched.
			`|\n${member.signature
				.split("\n")
				.map((line) => `  ${line}`)
				.join("\n")}`,
		],
	])
}

function memberBody(type: TypeEntry, member: Member): string {
	let sections: string[] = []

	if (member.parameters.length > 0) {
		let rows = member.parameters
			.map(
				(parameter) =>
					`\t\t{\n\t\t\tname: ${JSON.stringify(parameter.name)},\n\t\t\ttype: ${JSON.stringify(parameter.type)},\n\t\t\tdescription: ${JSON.stringify(oneLine(parameter.description))},\n\t\t},`,
			)
			.join("\n")

		sections.push(
			`## Parameters\n\n<ParamTable\n\tparams={[\n${rows}\n\t]}\n/>`,
		)
	}

	if (member.returns !== null) {
		sections.push(`## Returns\n\n${escapeMdx(oneLine(member.returns))}`)
	}

	sections.push(
		`## See also\n\n<SeeAlso\n\tlinks={[\n\t\t{ label: ${JSON.stringify(
			type.namespace,
		)}, href: "/docs/${SECTION}/${type.slug}" },\n\t]}\n/>`,
	)

	return `\n${sections.join("\n\n")}\n`
}

function typeFrontmatter(
	type: TypeEntry,
	namespace: Namespace | undefined,
	nestUnder: TypeEntry | undefined,
): string {
	let conformsTo = (namespace?.conformsTo ?? []).map((clause) =>
		clause.condition === null
			? clause.protocol
			: `${clause.protocol} where ${clause.condition}`,
	)

	return frontmatter([
		["title", quoted(type.namespace)],
		["description", quoted(namespace?.summary ?? type.description)],
		["section", SECTION],
		["order", String(type.order)],
		["template", "type"],
		["kind", '"type"'],
		["monoTitle", "true"],
		["namespace", quoted(type.namespace)],
		...(nestUnder === undefined
			? []
			: ([
					// The union this type is a case of. Only the navigation reads it:
					// the page keeps its own URL, because being a case of `Number` is
					// not the same as living inside it.
					["nestUnder", quoted(`${SECTION}/${nestUnder.slug}`)],
				] as Array<[string, string]>)),
		[
			"conformsTo",
			conformsTo.length === 0
				? "[]"
				: `\n${conformsTo.map((entry) => `  - ${JSON.stringify(entry)}`).join("\n")}`,
		],
	])
}

/*
 * A type page's body starts empty, and that is deliberate.
 *
 * The lede is already the description, and the template draws the conformances
 * and the whole Member index around whatever is here — so an unwritten page is
 * a complete and correct one, not a broken one. Restating the lede as the first
 * paragraph, which is what this did at first, only publishes the same sentence
 * twice and reads as a page that has nothing to say.
 *
 * What belongs here is the part nobody can generate: what the type is for, what
 * it rules out, when to reach for it. It goes in when somebody writes it.
 */
function typeBody(): string {
	return "\n"
}

function write(file: string, contents: string): void {
	mkdirSync(path.dirname(file), { recursive: true })
	writeFileSync(file, contents)
}

/*
 * The fields `--sync` will not touch, and the reason there is such a list.
 *
 * A signature is a fact about the language and has to be able to travel. A lede
 * is not: `Integer::add` was given "the result is always exact — it widens into
 * whichever type can still say the answer, and never rounds", which is better
 * than the one-line summary the `§§` block opens with, and a sync that replaced
 * it would quietly undo somebody's work every time the sources were touched.
 *
 * So the generated value seeds these when the page is created and never
 * overwrites them afterwards. Fields the generator does not write at all — a
 * `since`, a `tocDepth` — are kept for the same reason: not knowing about a
 * field is not a licence to drop it.
 */
const AUTHORED = new Set(["description"])

/** Frontmatter as ordered `key → raw value`, block scalars and lists included. */
function parseFrontmatter(block: string): Array<[string, string]> {
	let fields: Array<[string, string]> = []
	let lines = block.split("\n")

	for (let index = 0; index < lines.length; index++) {
		let match = /^([a-zA-Z]+): ?(.*)$/.exec(lines[index]!)

		if (match === null) {
			continue
		}

		let value = match[2]!

		// A block scalar or a list runs on until a line that is not indented.
		while (
			index + 1 < lines.length &&
			/^\s+\S/.test(lines[index + 1]!) &&
			!/^[a-zA-Z]+:/.test(lines[index + 1]!)
		) {
			value += `\n${lines[++index]}`
		}

		fields.push([match[1]!, value])
	}

	return fields
}

/**
 * Brings the generated fields forward, keeps the authored ones, and keeps
 * anything the generator has never heard of. Everything below the frontmatter
 * is untouched.
 */
function syncFrontmatter(file: string, next: string): boolean {
	let existing = readFileSync(file, "utf8")
	let match = /^---\n([\s\S]*?)\n---\n/.exec(existing)

	if (match === null) {
		throw new Error(`${file} has no frontmatter block to sync.`)
	}

	let current = new Map(parseFrontmatter(match[1]!))
	let generated = parseFrontmatter(/^---\n([\s\S]*?)\n---\n/.exec(next)![1]!)
	let written = new Set(generated.map(([key]) => key))

	let merged = [
		...generated.map(([key, value]): [string, string] =>
			AUTHORED.has(key) && current.has(key)
				? [key, current.get(key)!]
				: [key, value],
		),
		...[...current].filter(([key]) => !written.has(key)),
	]

	let updated =
		`---\n${merged.map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n` +
		existing.slice(match[0].length)

	if (updated === existing) {
		return false
	}

	writeFileSync(file, updated)

	return true
}

function main(): void {
	let { namespaces, aliases, undocumented } = readSurface()
	let byName = new Map(
		namespaces.map((namespace) => [namespace.name, namespace]),
	)
	let byNamespace = new Map(TYPES.map((type) => [type.namespace, type]))
	let parents = nesting(aliases, new Set(byNamespace.keys()))
	let known = new Set([
		...TYPES.map((type) => type.namespace),
		...Object.keys(MERGED_INTO),
	])

	let unplaced = namespaces
		.map((namespace) => namespace.name)
		.filter((name) => !known.has(name))

	if (unplaced.length > 0) {
		throw new Error(
			`The standard library declares ${unplaced.join(", ")}, which no entry in TYPES gives a place. Add it there — where a type sits in the reference is a decision, not a default.`,
		)
	}

	if (undocumented.length > 0) {
		console.log(
			`  ${undocumented.length} members carry no §§ block and will have an empty lede:`,
		)

		for (let hole of undocumented.slice(0, 10)) {
			console.log(`    ${hole.namespace}.${hole.member}`)
		}
	}

	/*
	 * Not an error, and not something this can fix: a Method that takes an
	 * argument nothing has been written about gets a page with no Parameters
	 * table, because there is nothing to put in one. The `@param` has to be
	 * written in the standard library, where the editor will show it too. Said
	 * out loud on every run, because the page it produces looks finished.
	 */
	let undescribed = namespaces.flatMap((namespace) =>
		namespace.members
			.filter(
				(member) =>
					member.declaredParameters > 0 &&
					member.parameters.length === 0,
			)
			.map((member) => `${namespace.name}::${member.name}`),
	)

	if (undescribed.length > 0) {
		console.log(
			`  ${undescribed.length} members take arguments that no @param describes, so their pages have no Parameters table:`,
		)
		console.log(
			`    ${undescribed.slice(0, 6).join(", ")}${undescribed.length > 6 ? `, and ${undescribed.length - 6} more` : ""}`,
		)
	}

	let created = 0
	let synced = 0
	let members = 0

	for (let type of TYPES) {
		let own = byName.get(type.namespace)
		let merged = Object.entries(MERGED_INTO)
			.filter(([, target]) => target === type.namespace)
			.flatMap(([source]) => {
				let namespace = byName.get(source)

				return (namespace?.members ?? []).map((member) => ({
					// A merged Member's own order counts from zero in the Namespace it
					// was declared in, which would put it in front of the type's own
					// first Member. Pushed past them instead: `flatten` is the last
					// thing on List, not the thing before `is`.
					member: { ...member, order: member.order + 1000 },
					declaringNamespace: type.namespace,
				}))
			})

		let all = [
			...(own?.members ?? []).map((member) => ({
				member,
				declaringNamespace: type.namespace,
			})),
			...merged,
		]

		let typePage = path.join(DOCS, SECTION, `${type.slug}.mdx`)
		let head = typeFrontmatter(
			type,
			own,
			byNamespace.get(parents.get(type.namespace) ?? ""),
		)

		if (!existsSync(typePage)) {
			write(typePage, head + typeBody())
			created++
		} else if (sync && syncFrontmatter(typePage, head)) {
			synced++
		}

		let slugs = new Set<string>()

		for (let { member, declaringNamespace } of all) {
			let slug = slugify(member.name)

			if (slugs.has(slug)) {
				throw new Error(
					`${type.namespace} has two members that slug to "${slug}" — one of them needs a name the URL can tell apart.`,
				)
			}

			slugs.add(slug)
			members++

			let file = path.join(DOCS, SECTION, type.slug, `${slug}.mdx`)
			let block = memberFrontmatter(type, member, declaringNamespace)

			if (!existsSync(file)) {
				write(file, block + memberBody(type, member))
				created++
			} else if (sync && syncFrontmatter(file, block)) {
				synced++
			}
		}
	}

	console.log(
		`  ${TYPES.length} types, ${members} members — ${created} pages created${
			sync ? `, ${synced} frontmatter blocks refreshed` : ""
		}.`,
	)
}

main()
