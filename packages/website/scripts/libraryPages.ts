/*
 * Where every declaration of the standard library is published, and what each
 * library page holds as a result.
 *
 * ── Placement is by rule ─────────────────────────────────────────────────────
 *
 * There is no list of Types here to fall behind the sources. Every declaration
 * is placed by what it is for:
 *
 *   1. A Namespace with a `for` target goes to the page of its target's head
 *      Type: `GroupedList for List<ItemType>` and `IntegerList for
 *      List<Integer>` both go to List.
 *   2. A head that is a checked refinement stands for its base: `NonEmptyList`
 *      is a List, `NonZeroInteger` an Integer.
 *   3. A Choice, and any alias that is not a refinement, goes to the page of
 *      the first Type its file declares a page for: `Division` to Integer,
 *      `Stream` to Terminal, `Scalar` to Number. One that is itself that first
 *      Type heads its own page, as Optional, Result, Ordering and Number do.
 *   4. A Namespace with no target gets a page named after itself: Terminal.
 *   5. A free Function family gets a page named after itself (`loop`), and
 *      every Protocol goes to the Protocols page — Generatable too, though
 *      `Randomness.es` declares it.
 *   6. One override, `Step`: its file declares the Choice and nothing a page
 *      could hang from. It goes to `loop`, because the callback of a `step`
 *      form of `loop` returns one. The only other callback that does is
 *      `List::reduce`'s early-stopping form; a plain `loop` body does not.
 *
 * "The first Type a file declares a page for" is the first Namespace in the
 * file over a Type no file declares (`Integer`, `List`), over a refinement of
 * one, or over nothing at all; failing that, the first Choice or alias the file
 * both declares and writes a Namespace for.
 *
 * A declaration no rule places throws. So does a page the rules produce that
 * `libraryTable.ts` does not list, and a listed page nothing lands on.
 *
 * ── Grouping is by table ─────────────────────────────────────────────────────
 *
 * Inside a page the reader groups come from `libraryTable.ts`, keyed
 * `Namespace::member`. Every member placed on a page has to be in exactly one of
 * its groups, and every provided or derived member too, or this throws: a
 * Method the sources gain is a decision about where a reader will look for it,
 * and the generator stops until somebody makes it.
 */

import { builtinProtocolOrder } from "@essence-lang/compiler/enricher/builtins"

import type {
	ManifestAlias,
	ManifestEntry,
	ManifestGroup,
	ManifestLink,
	ManifestMember,
	ManifestMode,
	ManifestProtocol,
	ManifestRefinement,
	PageKind,
	PageManifest,
} from "./libraryManifest.ts"
import { type PageDefinition, PAGES } from "./libraryTable.ts"
import type {
	Alias,
	Choice,
	Entry,
	FunctionFamily,
	Member,
	Namespace,
	Protocol,
	ProtocolMethod,
	ProvidedMember,
	Surface,
} from "./stdlibSurface.ts"

export const LIBRARY_ROOT = "/docs/library"

const PROTOCOLS = "protocols"

/*
 * The one declaration no rule can place. `Step.es` declares the Choice and no
 * Namespace, so nothing names a page it belongs on — and a reader meets it
 * where a callback has to return one: the `step` forms of `loop`, and the
 * early-stopping form of `List::reduce`.
 */
const OVERRIDES: Record<string, string> = {
	Step: "loop",
	// NOTE: One run of a Future has no page of its own — what a Started IS can
	// not be said without saying what a Future is, and the two are met
	// together. Nor has the Namespace that BUILDS one, for the same reason, nor
	// the four narrower targets: each of them is a Method about work, and a
	// reader looking for one is looking at the page about work.
	Started: "Future",
	Async: "Future",
	ResultFuture: "Future",
	FutureList: "Future",
	NonEmptyFutureList: "Future",
	ResultFutureList: "Future",
}

/*
 * The labels every `loop` entry of its kind shares: the seed, the start of a
 * count and the positional body. What is left tells the entry apart — `while`,
 * `through`, `through-step` — and is its heading.
 */
const SHARED_LOOP_LABELS = new Set(["_", "from", "startingWith"])

/*
 * What a Protocol hands out without a line saying so, in prose. Each sentence
 * was checked against the Compiler before it went in: a payload Choice with no
 * Namespace answers `is` and `isNot`, and tells `#Circle(2)` from `#Circle(3)`;
 * an empty `namespace Light for Light is Printable {}` prints `Red`, and the
 * Choice without it has no `toString`; `Side.cases()` prints
 * `[Start, End, BothEnds]`; interpolating a Function is
 * `interpolation-not-printable`.
 */
const PROTOCOL_NOTES: Record<string, string[]> = {
	Equatable: [
		"Every choice has `is` and `isNot` without declaring `Equatable`. Two of its values are equal when they are the same case with equal payloads.",
	],
	Printable: [
		"A choice whose cases carry no payload prints its case name once a namespace declares `is Printable` for it. The namespace body can stay empty: `namespace Side for Side is Equatable, is Printable {}`.",
		"An interpolation hole in a String needs a `Printable` value. Any other value is [`interpolation-not-printable`](/docs/reference/diagnostics#interpolation-not-printable).",
	],
	Enumerable: [
		"Every choice whose cases carry no payload has the static `cases()` without declaring `Enumerable`. It returns the cases in the order they are declared: `Side.cases()` is `[Start, End, BothEnds]`.",
	],
}

export interface LibraryPage {
	definition: PageDefinition
	/** Everything but the heading ids, which the writer settles as it lays the headings out. */
	manifest: Omit<PageManifest, "anchors">
	/** The `§§` block of the declaration the page is named after, when it has one. */
	lede: string | null
}

/** `Integer` → `integer`, `SortOrder` → `sort-order`. */
export function slugify(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
		.toLowerCase()
}

/** The labels that tell a `loop` entry from the rest of its family. */
export function loopLabel(entry: Entry): string {
	return entry.parameters
		.map((parameter) => parameter.label)
		.filter((label) => !SHARED_LOOP_LABELS.has(label))
		.join("-")
}

/*
 * How a call names one entry — `List::append(_:)`, `Integer.parse(_:)`,
 * `Number.Pi`, `loop(from:through:startingWith:_:)` — so a list of entries from
 * all over the library reads as calls a reader could write.
 */
function selector(
	owner: string | null,
	name: string,
	entry: Entry,
	kind: Member["kind"] | "function",
): string {
	let labels = entry.parameters.map((parameter) => `${parameter.label}:`)

	if (kind === "property") {
		return `${owner}.${name}`
	}

	let call = `${name}(${labels.join("")})`

	if (owner === null) {
		return call
	}

	return `${owner}${kind === "method" ? "::" : "."}${call}`
}

function mentions(text: string, name: string): boolean {
	return new RegExp(`\\b${name}\\b`).test(text)
}

function byPosition(
	a: { fileName: string; line: number },
	b: { fileName: string; line: number },
): number {
	return a.fileName.localeCompare(b.fileName) || a.line - b.line
}

function uniqueByLabel<Link extends ManifestLink>(links: Link[]): Link[] {
	let seen = new Set<string>()

	return links.filter((link) => {
		if (seen.has(link.label)) {
			return false
		}

		seen.add(link.label)

		return true
	})
}

class Placement {
	private choices: Map<string, Choice>
	private aliases: Map<string, Alias>
	private primaries = new Map<string, string | null>()

	constructor(private surface: Surface) {
		this.choices = new Map(
			surface.choices.map((choice) => [choice.name, choice]),
		)
		this.aliases = new Map(
			surface.aliases.map((alias) => [alias.name, alias]),
		)
	}

	/** The Type tag a head stands for, through any refinements; null for a Choice or a union. */
	private tagOf(name: string): string | null {
		if (!this.choices.has(name) && !this.aliases.has(name)) {
			return name
		}

		let alias = this.aliases.get(name)

		return alias?.predicate != null && alias.base !== null
			? this.tagOf(alias.base)
			: null
	}

	/** The Type a file declares a page for — see the rules at the top. */
	private primaryOf(fileName: string): string | null {
		if (this.primaries.has(fileName)) {
			return this.primaries.get(fileName)!
		}

		let namespaces = this.surface.namespaces
			.filter((namespace) => namespace.fileName === fileName)
			.sort(byPosition)
		let found: string | null = null

		for (let namespace of namespaces) {
			if (namespace.targetHead === null) {
				found = namespace.name
				break
			}

			let tag = this.tagOf(namespace.targetHead)

			if (tag !== null) {
				found = tag
				break
			}
		}

		if (found === null) {
			let declared = [...this.surface.choices, ...this.surface.aliases]
				.filter((declaration) => declaration.fileName === fileName)
				.sort(byPosition)

			found =
				declared.find((declaration) =>
					namespaces.some(
						(namespace) =>
							namespace.targetHead === declaration.name,
					),
				)?.name ?? null
		}

		this.primaries.set(fileName, found)

		return found
	}

	/** The name of the page a Type is published on. */
	pageOfType(name: string): string {
		let override = OVERRIDES[name]

		if (override !== undefined) {
			return override
		}

		let tag = this.tagOf(name)

		if (tag !== null) {
			return tag
		}

		let declaration = this.choices.get(name) ?? this.aliases.get(name)!
		let primary = this.primaryOf(declaration.fileName)

		if (primary === null) {
			throw new Error(
				`${name} is declared in ${declaration.fileName}, which declares no Type a page is named after, and no rule in libraryPages.ts places it. Give it a place: a Namespace in its file, or an entry in OVERRIDES.`,
			)
		}

		return primary === name ? name : this.pageOfType(primary)
	}

	pageOfNamespace(namespace: Namespace): string {
		// NOTE: The Namespace's OWN name first, because a narrower target is
		// not always where a reader looks for it. `FutureList` targets a List
		// of Futures, whose head is `List`, and every Method it declares is
		// about work rather than about Lists — so the page it belongs on is the
		// one about work, which only an override can say.
		let override = OVERRIDES[namespace.name]

		if (override !== undefined) {
			return override
		}

		if (namespace.targetHead !== null) {
			return this.pageOfType(namespace.targetHead)
		}

		// NOTE: A Namespace with no target is its own page — `Terminal`,
		// `Randomness` — unless the override above said otherwise. `Async` is
		// the one that does: what it builds is a Future, and a page about making
		// one with no page about what one IS beside it teaches half the idea.
		return namespace.name
	}
}

interface Placed {
	namespaces: Namespace[]
	choices: Choice[]
	aliases: Alias[]
	protocols: Protocol[]
	functions: FunctionFamily[]
}

/** The declaration a page is named after, and what that makes the page. */
interface Head {
	kind: PageKind
	namespace: Namespace | null
	choice: Choice | null
	alias: Alias | null
	family: FunctionFamily | null
}

/** One entry anywhere in the library, as a list elsewhere links to it. */
interface Indexed {
	selector: string
	href: string
	entry: Entry
}

export function buildLibrary(surface: Surface): LibraryPage[] {
	let placement = new Placement(surface)
	let definitions = new Map(PAGES.map((page) => [page.slug, page]))
	let placed = new Map<string, Placed>()
	let pageOfNamespace = new Map<string, string>()

	let at = (slug: string, what: string): Placed => {
		if (!definitions.has(slug)) {
			throw new Error(
				`The placement rules put ${what} on library/${slug}, which libraryTable.ts does not list. Add the page there, with its order and its groups — a new page is a decision, not a default.`,
			)
		}

		let entry = placed.get(slug)

		if (entry === undefined) {
			entry = {
				namespaces: [],
				choices: [],
				aliases: [],
				protocols: [],
				functions: [],
			}
			placed.set(slug, entry)
		}

		return entry
	}

	for (let namespace of surface.namespaces) {
		let slug = slugify(placement.pageOfNamespace(namespace))

		at(slug, `the Namespace ${namespace.name}`).namespaces.push(namespace)
		pageOfNamespace.set(namespace.name, slug)
	}

	for (let choice of surface.choices) {
		at(
			slugify(placement.pageOfType(choice.name)),
			`the Choice ${choice.name}`,
		).choices.push(choice)
	}

	for (let alias of surface.aliases) {
		at(
			slugify(placement.pageOfType(alias.name)),
			`the alias ${alias.name}`,
		).aliases.push(alias)
	}

	for (let protocol of surface.protocols) {
		at(PROTOCOLS, `the Protocol ${protocol.name}`).protocols.push(protocol)
	}

	for (let family of surface.functions) {
		at(slugify(family.name), `the Function ${family.name}`).functions.push(
			family,
		)
	}

	let empty = PAGES.filter((page) => !placed.has(page.slug))

	if (empty.length > 0) {
		throw new Error(
			`libraryTable.ts lists ${empty.map((page) => `library/${page.slug}`).join(", ")}, but no declaration lands there.`,
		)
	}

	let headOf = (slug: string, on: Placed): Head => {
		let none = { namespace: null, choice: null, alias: null, family: null }

		if (slug === PROTOCOLS) {
			return { kind: "protocols", ...none }
		}

		let family = on.functions.find(
			(candidate) => slugify(candidate.name) === slug,
		)

		if (family !== undefined) {
			return { kind: "function family", ...none, family }
		}

		let namespace = on.namespaces.find(
			(candidate) => slugify(candidate.name) === slug,
		)

		if (namespace === undefined) {
			throw new Error(
				`No Namespace on library/${slug} is named after the page, so nothing says what the page is about.`,
			)
		}

		let choice =
			on.choices.find(
				(candidate) =>
					candidate.name === namespace.name &&
					namespace.targetHead === namespace.name,
			) ?? null

		return {
			kind:
				choice !== null
					? "choice"
					: namespace.targetType === null
						? "namespace"
						: "type",
			namespace,
			choice,
			alias:
				on.aliases.find(
					(candidate) =>
						candidate.name === namespace.name &&
						candidate.predicate === null,
				) ?? null,
			family: null,
		}
	}

	let heads = new Map(
		[...placed].map(([slug, on]) => [slug, headOf(slug, on)] as const),
	)

	/*
	 * The names a signature or a Parameter's Type links to where they are
	 * documented: refinements, the Choices a page hosts, and Protocols. A Type
	 * with a page of its own is not among them — `Integer` in every other
	 * signature would be a page of underlines.
	 */
	let links: Record<string, string> = {}

	for (let [slug, on] of placed) {
		for (let alias of on.aliases) {
			if (alias.predicate !== null) {
				links[alias.name] = `${LIBRARY_ROOT}/${slug}#${alias.name}`
			}
		}

		for (let choice of on.choices) {
			if (heads.get(slug)!.choice?.name !== choice.name) {
				links[choice.name] = `${LIBRARY_ROOT}/${slug}#${choice.name}`
			}
		}

		for (let protocol of on.protocols) {
			links[protocol.name] =
				`${LIBRARY_ROOT}/${PROTOCOLS}#${protocol.name}`
		}
	}

	let hrefOfType = (type: string): string | null => {
		let head = /^([A-Z][A-Za-z0-9]*)(<.*>)?$/.exec(type.trim())?.[1]

		return head === undefined ? null : (links[head] ?? null)
	}

	let toManifestEntry = (entry: Entry): ManifestEntry => ({
		signature: entry.signature,
		summary: entry.documentation?.description ?? "",
		parameters: entry.parameters.map((parameter) => ({
			name: parameter.label,
			type: parameter.type,
			default: parameter.default,
			description: parameter.description ?? "",
			href: hrefOfType(parameter.type),
		})),
		returns: entry.documentation?.returns ?? null,
		examples: entry.documentation?.examples ?? [],
	})

	let index: Indexed[] = [
		...surface.namespaces.flatMap((namespace) =>
			namespace.members.flatMap((member) =>
				member.entries.map((entry) => ({
					selector: selector(
						namespace.name,
						member.name,
						entry,
						member.kind,
					),
					href: `${LIBRARY_ROOT}/${pageOfNamespace.get(namespace.name)}#${member.name}`,
					entry,
				})),
			),
		),
		...surface.functions.flatMap((family) =>
			family.entries.map((entry) => ({
				selector: selector(null, family.name, entry, "function"),
				href: `${LIBRARY_ROOT}/${slugify(family.name)}#${loopLabel(entry)}`,
				entry,
			})),
		),
	]

	let declaredAnywhere = new Set(
		surface.namespaces.flatMap((namespace) =>
			namespace.members.map(
				(member) => `${namespace.name}::${member.name}`,
			),
		),
	)

	let protocolByName = new Map(
		surface.protocols.map((protocol) => [protocol.name, protocol]),
	)
	let lineage = (name: string): string[] => [
		name,
		...(protocolByName.get(name)?.extends ?? []).flatMap(lineage),
	]

	let pages = PAGES.map((definition): LibraryPage => {
		let slug = definition.slug
		let on = placed.get(slug)!
		let head = heads.get(slug)!

		let isRefinementNamespace = (namespace: Namespace) =>
			namespace.targetHead === namespace.name &&
			on.aliases.some(
				(alias) =>
					alias.name === namespace.name && alias.predicate !== null,
			)
		let modeChoices = on.choices
			.filter((choice) => choice.name !== head.choice?.name)
			.sort(byPosition)
		let isModeNamespace = (namespace: Namespace) =>
			namespace.targetHead === namespace.name &&
			modeChoices.some((choice) => choice.name === namespace.name)

		let declared = new Map<string, ManifestMember>()

		for (let namespace of on.namespaces) {
			for (let member of namespace.members) {
				declared.set(`${namespace.name}::${member.name}`, {
					key: `${namespace.name}::${member.name}`,
					namespace: namespace.name,
					name: member.name,
					receiver:
						member.kind === "method"
							? (namespace.targetType ?? namespace.name)
							: namespace.name,
					kind: member.kind,
					origin: "declared",
					protocol: null,
					condition: null,
					summary: member.documentation?.description ?? null,
					returns: member.documentation?.returns ?? null,
					examples: member.documentation?.examples ?? [],
					entries: member.entries.map(toManifestEntry),
				})
			}
		}

		for (let family of on.functions) {
			for (let entry of family.entries) {
				let label = loopLabel(entry)
				let key = `${family.name}::${label}`

				if (label === "" || declared.has(key)) {
					throw new Error(
						`Two entries of ${family.name} are told apart by the same labels ("${label}"), so they would share one heading and one address.`,
					)
				}

				declared.set(key, {
					key,
					namespace: family.name,
					name: label,
					receiver: null,
					kind: "function",
					origin: "declared",
					protocol: null,
					condition: null,
					summary: null,
					returns: null,
					examples: [],
					entries: [toManifestEntry(entry)],
				})
			}
		}

		// A mode's derived and provided Methods are said once, in the lede of
		// the page's Modes section, not published per Choice.
		let provided = new Map<string, ManifestMember[]>()

		for (let member of surface.provided) {
			let namespace = on.namespaces.find(
				(candidate) => candidate.name === member.namespace,
			)

			if (namespace === undefined || isModeNamespace(namespace)) {
				continue
			}

			provided.set(member.name, [
				...(provided.get(member.name) ?? []),
				providedMember(member, namespace),
			])
		}

		function providedMember(
			member: ProvidedMember,
			namespace: Namespace,
		): ManifestMember {
			return {
				key: `${member.namespace}::${member.name}`,
				namespace: member.namespace,
				name: member.name,
				receiver: member.static
					? namespace.name
					: (namespace.targetType ?? namespace.name),
				kind: member.static ? "static method" : "method",
				origin: member.derived ? "derived" : "provided",
				protocol: member.protocol,
				condition: member.condition,
				summary: null,
				returns: null,
				examples: [],
				entries: member.entries.map(toManifestEntry),
			}
		}

		let used = new Set<string>()
		let claim = (member: ManifestMember, group: string) => {
			if (used.has(member.key)) {
				throw new Error(
					`libraryTable.ts lists ${member.key} twice on library/${slug} (again in "${group}"). A member belongs to exactly one group.`,
				)
			}

			used.add(member.key)

			return member
		}

		let groups: ManifestGroup[] = definition.groups.map((group) => ({
			label: group.label,
			id: "",
			members: [
				...group.members.map((key) => {
					let member = declared.get(key)

					if (member === undefined) {
						throw new Error(
							`libraryTable.ts puts ${key} in "${group.label}" on library/${slug}, but ${
								declaredAnywhere.has(key)
									? "the placement rules put it on another page"
									: "the standard library declares no such member"
							}.`,
						)
					}

					return claim(member, group.label)
				}),
				...(group.provided ?? []).flatMap((name) => {
					let found = provided.get(name)

					if (found === undefined) {
						throw new Error(
							`libraryTable.ts shows ${name} in "${group.label}" on library/${slug} as provided, but no conformance on the page provides it.`,
						)
					}

					return found.map((member) => claim(member, group.label))
				}),
			],
		}))

		if (head.kind === PROTOCOLS) {
			groups = [...on.protocols]
				.sort(
					(a, b) =>
						rankOf(a.name) - rankOf(b.name) || byPosition(a, b),
				)
				.map((protocol) => ({
					label: protocol.name,
					id: "",
					members: protocol.methods.map((method) =>
						claim(protocolMember(protocol, method), protocol.name),
					),
				}))
		}

		function protocolMember(
			protocol: Protocol,
			method: ProtocolMethod,
		): ManifestMember {
			return {
				key: `${protocol.name}::${method.name}`,
				namespace: protocol.name,
				name: method.name,
				receiver: null,
				kind: method.static ? "static method" : "method",
				origin: method.provided ? "provided" : "requirement",
				protocol: protocol.name,
				condition: null,
				summary: null,
				returns: null,
				examples: [],
				entries: method.entries.map(toManifestEntry),
			}
		}

		let ungrouped = [
			...declared.keys(),
			...[...provided.values()].flat().map((member) => member.key),
		].filter((key) => !used.has(key))

		if (ungrouped.length > 0) {
			throw new Error(
				`library/${slug} carries ${ungrouped.join(", ")}, which no group in libraryTable.ts lists. Put each where a reader would look for it.`,
			)
		}

		let kinds = new Map<string, Set<string>>()

		for (let member of groups.flatMap((group) => group.members)) {
			kinds.set(
				member.name,
				(kinds.get(member.name) ?? new Set()).add(
					member.kind === "method" ? "method" : "static",
				),
			)
		}

		for (let [name, found] of kinds) {
			if (found.size > 1) {
				throw new Error(
					`library/${slug} has a static and a method both named ${name}. One heading cannot address both, and the page would need a second rule to tell them apart.`,
				)
			}
		}

		let headings = [
			...new Set(
				groups.flatMap((group) =>
					group.members.map((member) => member.name),
				),
			),
		]
		let targetOf = new Map(
			surface.namespaces.map((namespace) => [
				namespace.name,
				namespace.targetHead,
			]),
		)

		let refinements: ManifestRefinement[] = on.aliases
			.filter((alias) => alias.predicate !== null)
			.sort(byPosition)
			.map((alias) => ({
				name: alias.name,
				written: alias.written,
				declaration: alias.declaration,
				predicate: alias.predicate!,
				description: alias.documentation?.description ?? "",
				tightens: headings.filter((name) =>
					groups.some((group) =>
						group.members.some(
							(member) =>
								member.name === name &&
								targetOf.get(member.namespace) === alias.name,
						),
					),
				),
				answeredBy: uniqueByLabel(
					index
						.filter((indexed) =>
							mentions(indexed.entry.returnType, alias.name),
						)
						.map((indexed) => ({
							label: indexed.selector,
							href: indexed.href,
						})),
				),
			}))

		let modes: ManifestMode[] = modeChoices.map((choice) => ({
			name: choice.name,
			declaration: choice.declaration,
			description: choice.documentation?.description ?? "",
			cases: choice.cases,
			payloadFree: choice.cases.every((entry) => entry.payload === null),
			takenBy: uniqueByLabel(
				index.flatMap((indexed) => {
					let parameter = indexed.entry.parameters.find((candidate) =>
						mentions(candidate.type, choice.name),
					)

					return parameter === undefined
						? []
						: [
								{
									label: indexed.selector,
									href: indexed.href,
									default: parameter.default,
								},
							]
				}),
			),
		}))

		let tower: ManifestAlias[] = on.aliases
			.filter((alias) => alias.predicate === null)
			.sort(byPosition)
			.map((alias) => ({
				name: alias.name,
				declaration: alias.declaration,
				// The page's own alias has its `§§` as the page's lede already.
				description:
					alias.name === head.alias?.name
						? ""
						: (alias.documentation?.description ?? ""),
			}))

		let firstSeen = new Map<string, number>()

		groups
			.flatMap((group) => group.members)
			.forEach((member, position) => {
				if (!firstSeen.has(member.namespace)) {
					firstSeen.set(member.namespace, position)
				}
			})

		let rank = (namespace: Namespace) =>
			namespace === head.namespace
				? 0
				: isRefinementNamespace(namespace)
					? 1
					: isModeNamespace(namespace)
						? 3
						: 2
		// The head, its refinements in written order, its views in the order a
		// reader meets their members, then the modes.
		let namespaces = [...on.namespaces].sort(
			(a, b) =>
				rank(a) - rank(b) ||
				(rank(a) === 2
					? (firstSeen.get(a.name) ?? Infinity) -
						(firstSeen.get(b.name) ?? Infinity)
					: 0) ||
				byPosition(a, b),
		)

		let protocols: ManifestProtocol[] =
			head.kind === PROTOCOLS
				? groups.map((group) => {
						let protocol = protocolByName.get(group.label)!

						return {
							name: protocol.name,
							declaration: `${protocol.declaration} {\n${protocol.methods
								.flatMap((method) =>
									method.entries.map((entry) =>
										entry.signature
											.split("\n")
											.map((line) => `\t${line}`)
											.join("\n"),
									),
								)
								.join("\n")}\n}`,
							extends: protocol.extends,
							description:
								protocol.documentation?.description ?? "",
							conformers: conformersOf(protocol.name),
							derivedFor:
								protocol.name === "Enumerable"
									? enumerableChoices()
									: [],
							requiredBy: uniqueByLabel(
								index
									.filter((indexed) =>
										indexed.entry.generics.some(
											(generic) =>
												generic.bound === protocol.name,
										),
									)
									.map((indexed) => ({
										label: indexed.selector,
										href: indexed.href,
									})),
							),
							notes: PROTOCOL_NOTES[protocol.name] ?? [],
							// A provided Method has its heading on every page that
							// receives it. One nothing in the library receives would
							// have no address at all, so it gets its heading here.
							headed: protocol.methods
								.filter(
									(method) =>
										method.provided &&
										!surface.provided.some(
											(member) =>
												member.protocol ===
													protocol.name &&
												member.name === method.name,
										),
								)
								.map((method) => method.name),
						}
					})
				: []

		return {
			definition,
			lede:
				head.namespace?.documentation?.description ??
				head.choice?.documentation?.description ??
				head.alias?.documentation?.description ??
				head.family?.documentation?.description ??
				null,
			manifest: {
				slug,
				title: definition.title,
				kind: head.kind,
				declaration:
					head.namespace?.declaration ??
					head.family?.declaration ??
					"",
				choice: head.choice?.declaration ?? null,
				namespaces: namespaces.map((namespace) => namespace.name),
				conformsTo: head.namespace?.conformsTo ?? [],
				groups,
				refinements,
				modes,
				tower,
				towerLabel: definition.towerLabel ?? "The tower",
				views: on.namespaces
					.filter(
						(namespace) =>
							namespace !== head.namespace &&
							!isRefinementNamespace(namespace) &&
							!isModeNamespace(namespace),
					)
					.sort(
						(a, b) =>
							(firstSeen.get(a.name) ?? Infinity) -
								(firstSeen.get(b.name) ?? Infinity) ||
							byPosition(a, b),
					)
					.map((namespace) => ({
						namespace: namespace.name,
						target: namespace.targetType ?? namespace.name,
					})),
				protocols,
				seeAlso: [],
				links,
			},
		}
	})

	function rankOf(name: string): number {
		let position = builtinProtocolOrder.indexOf(name)

		return position === -1 ? builtinProtocolOrder.length : position
	}

	function hrefOfNamespace(namespace: Namespace): string {
		let slug = pageOfNamespace.get(namespace.name)!

		return links[namespace.name] ?? `${LIBRARY_ROOT}/${slug}`
	}

	function conformersOf(
		protocol: string,
	): Array<ManifestLink & { condition: string | null; via: string | null }> {
		return surface.namespaces.flatMap((namespace) => {
			let direct = namespace.conformsTo.find(
				(clause) => clause.protocol === protocol,
			)
			let through = namespace.conformsTo.find(
				(clause) =>
					clause.protocol !== protocol &&
					lineage(clause.protocol).includes(protocol),
			)
			let clause = direct ?? through

			return clause === undefined
				? []
				: [
						{
							label: namespace.name,
							href: hrefOfNamespace(namespace),
							condition: clause.condition,
							via: direct === undefined ? clause.protocol : null,
						},
					]
		})
	}

	function enumerableChoices(): ManifestLink[] {
		let order = new Map(
			PAGES.map((page, position) => [page.slug, position]),
		)

		return surface.choices
			.filter((choice) =>
				choice.cases.every((entry) => entry.payload === null),
			)
			.map((choice) => ({
				choice,
				slug: slugify(placement.pageOfType(choice.name)),
			}))
			.sort(
				(a, b) =>
					order.get(a.slug)! - order.get(b.slug)! ||
					byPosition(a.choice, b.choice),
			)
			.map(({ choice, slug }) => ({
				label: choice.name,
				href: links[choice.name] ?? `${LIBRARY_ROOT}/${slug}`,
			}))
	}

	/*
	 * The see-also rows are written as `library/<page>#<anchor>` in the table
	 * and resolved here, against the pages as built — a row pointing at a
	 * heading that no longer exists stops the generator rather than publishing
	 * a link to nowhere.
	 */
	for (let page of pages) {
		page.manifest.seeAlso = (page.definition.seeAlso ?? []).map(
			(target) => {
				let [path, anchor] = target.split("#") as [
					string,
					string | undefined,
				]
				let targetSlug = path.replace(/^library\//, "")
				let targetPage = pages.find(
					(candidate) => candidate.manifest.slug === targetSlug,
				)
				let heading = targetPage?.manifest.groups.some((group) =>
					group.members.some((member) => member.name === anchor),
				)
				let named =
					anchor !== undefined &&
					links[anchor] === `${LIBRARY_ROOT}/${targetSlug}#${anchor}`

				if (
					targetPage === undefined ||
					(anchor !== undefined && !heading && !named)
				) {
					throw new Error(
						`library/${page.manifest.slug} sees also ${target}, which no page or heading answers to.`,
					)
				}

				return {
					label:
						anchor === undefined
							? targetPage.manifest.title
							: named
								? anchor
								: `${targetPage.manifest.title}::${anchor}`,
					href: `${LIBRARY_ROOT}/${targetSlug}${anchor === undefined ? "" : `#${anchor}`}`,
				}
			},
		)
	}

	return pages
}
