/*
 * The shape of `src/content/docs/library/<slug>.json`: everything a library
 * page draws beyond its headings. `generateStdlibDocs.ts` writes one beside each
 * page's `.mdx` in the same run. The page components read it, and
 * `tests/stdlibMembers.spec.ts` checks it against the standard library.
 *
 * Types only, so the Astro side can import it without the Compiler.
 */

export type PageKind =
	| "type"
	| "choice"
	| "function family"
	| "namespace"
	| "protocols"

export interface ManifestParameter {
	/** The label a call writes, or `_` for a positional Parameter. */
	name: string
	/** As written. */
	type: string
	/** The `= …` a caller may leave out, as written. */
	default: string | null
	description: string
	/** Where the Type is documented, when it is a refinement or a mode. */
	href: string | null
}

export interface ManifestEntry {
	/** As written in the sources: name, generics, Parameters, return Type. */
	signature: string
	/** The entry's own `§§` description. */
	summary: string
	parameters: ManifestParameter[]
	returns: string | null
	examples: string[]
}

/**
 * Where a member comes from. `declared` is written in a Namespace. `provided`
 * comes with a conformance from a Protocol's body. `derived` is answered for a
 * Choice from its Cases. `requirement` is what a Protocol asks of a conformer.
 */
export type MemberOrigin = "declared" | "provided" | "derived" | "requirement"

export interface ManifestMember {
	/** `List::firstItem`, `Integer::clamp`, `loop::through-step`, `Equatable::is`. */
	key: string
	/** The Namespace, Function family or Protocol it belongs to. */
	namespace: string
	/** The name its heading carries; for a `loop` entry, the labels that tell it apart. */
	name: string
	/** What the entries are called on: `List<ItemType>`, `Integer`; null for a free Function or a Protocol. */
	receiver: string | null
	kind: "method" | "static method" | "property" | "function"
	origin: MemberOrigin
	/** The Protocol behind a provided, derived or required member. */
	protocol: string | null
	/** The conformance's `where` clause, when it only holds under one. */
	condition: string | null
	/** The `§§` block an `overload` writes for the whole set. */
	summary: string | null
	returns: string | null
	examples: string[]
	entries: ManifestEntry[]
}

export interface ManifestGroup {
	label: string
	/** The id of the group's `##` heading. */
	id: string
	members: ManifestMember[]
}

export interface ManifestLink {
	label: string
	href: string
}

export interface ManifestRefinement {
	name: string
	/** `NonEmptyList<ItemType>` */
	written: string
	/** `type NonEmptyList<ItemType> = List<ItemType> where @::hasItems()` */
	declaration: string
	predicate: string
	description: string
	/** The headings on this page that have an entry on the refinement. */
	tightens: string[]
	/** Every entry on the site whose return Type names the refinement. */
	answeredBy: ManifestLink[]
}

export interface ManifestMode {
	name: string
	/** The whole `choice` block, as written. */
	declaration: string
	description: string
	cases: Array<{ name: string; payload: string | null }>
	payloadFree: boolean
	/** Every entry on the site with a Parameter of this Type, and its default there. */
	takenBy: Array<ManifestLink & { default: string | null }>
}

/**
 * What the section of a page's hosted Choices is called. A mode, such as
 * `Rounding`, is a payload-free Choice that picks how a Method works. `Step`
 * carries payloads, so its section is named for what it holds.
 */
export function modesTitle(modes: ManifestMode[]): "Modes" | "Choices" {
	return modes.every((mode) => mode.payloadFree) ? "Modes" : "Choices"
}

export interface ManifestAlias {
	name: string
	declaration: string
	description: string
}

export interface ManifestProtocol {
	name: string
	/** The declaration with its members' signatures, bodies left out. */
	declaration: string
	extends: string[]
	description: string
	/** Every Namespace that conforms, directly or through a Protocol that extends this one. */
	conformers: Array<
		ManifestLink & { condition: string | null; via: string | null }
	>
	/** The Choices that answer it without declaring it. */
	derivedFor: ManifestLink[]
	/** Every entry whose generics bound a Type Parameter by this Protocol. */
	requiredBy: ManifestLink[]
	/** What a Choice or a program gets from the Protocol without a line saying so. */
	notes: string[]
	/** Provided Methods no Namespace receives, which therefore have their heading on this page. */
	headed: string[]
}

export interface PageManifest {
	/** As in `/docs/library/<slug>`. */
	slug: string
	title: string
	kind: PageKind
	/** The declaration the page is named after, on one line. */
	declaration: string
	/** A choice page's whole `choice` block. */
	choice: string | null
	/** Every Namespace the page folds, as the sources spell them. */
	namespaces: string[]
	conformsTo: Array<{ protocol: string; condition: string | null }>
	groups: ManifestGroup[]
	refinements: ManifestRefinement[]
	modes: ManifestMode[]
	/** The union aliases a page explains (the numeric tower). */
	tower: ManifestAlias[]
	/** What the page calls that section. "The tower" is the numeric page's. */
	towerLabel: string
	/** The folded Namespaces that are neither a refinement's nor a mode's, with the Type each is for. */
	views: Array<{ namespace: string; target: string }>
	protocols: ManifestProtocol[]
	seeAlso: ManifestLink[]
	/** Refinement, mode and Protocol names, site-wide, and where each is documented. */
	links: Record<string, string>
	/** Every id the rendered page carries, in document order. */
	anchors: string[]
}
