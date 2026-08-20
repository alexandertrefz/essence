import { glob } from "astro/loaders"
import { defineCollection, z } from "astro:content"

// NOTE: The section a page belongs to is a closed set rather than a free
// string, because it is also the sidebar's grouping and its fixed order —
// a typo in frontmatter would otherwise silently invent a group nobody
// navigates to.
export const SECTIONS = [
	"getting-started",
	"language",
	"standard-library",
	"guides",
	"reference",
] as const

let docs = defineCollection({
	loader: glob({ base: "./src/content/docs", pattern: "**/*.{md,mdx}" }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		section: z.enum(SECTIONS),
		order: z.number(),
		/** Which page template renders this entry. */
		template: z
			.enum(["article", "guide", "reference", "type"])
			.default("article"),
		/** Deepest heading level the on-this-page list shows. */
		tocDepth: z.number().default(3),

		/** Guide meta. */
		steps: z.number().optional(),
		minutes: z.number().optional(),

		/** Reference meta. */
		kind: z.string().optional(),
		signature: z.string().optional(),
		since: z.string().optional(),
		/** Set the title in the mono face — `Integer::add` reads as code. */
		monoTitle: z.boolean().optional(),

		/*
		 * Standard library meta. `namespace` is the declaring Namespace as the
		 * sources spell it, which is what ties a page back to the declaration it
		 * documents — `tests/stdlibMembers.spec.ts` reads these two fields to
		 * check that every Member has a page and that no page claims a Member the
		 * library does not declare. `member` is absent on a type page, which is
		 * how the two are told apart.
		 */
		namespace: z.string().optional(),
		member: z.string().optional(),
		/*
		 * The id of a page this one is a case of — `Integer` under `Number`, which
		 * the standard library declares as `Integer | Rational | Algebraic |
		 * Transcendental`. It nests the entry in the sidebar and nowhere else: the
		 * page keeps its own URL, because being a case of a union is not the same
		 * as living inside it.
		 */
		nestUnder: z.string().optional(),
		/** Protocols the type conforms to, with the `where` clause when conditional. */
		conformsTo: z.array(z.string()).default([]),
	}),
})

export const collections = { docs }
