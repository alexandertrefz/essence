import { glob } from "astro/loaders"
import { defineCollection, z } from "astro:content"

// NOTE: The section a page belongs to is a closed set rather than a free
// string, because it is also the sidebar's grouping and its fixed order —
// a typo in frontmatter would otherwise silently invent a group nobody
// navigates to.
export const SECTIONS = [
	"getting-started",
	"language",
	"library",
	"guides",
	"reference",
] as const

let docs = defineCollection({
	loader: glob({ base: "./src/content/docs", pattern: "**/*.{md,mdx}" }),
	schema: z
		.object({
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
			/**
			 * Deepest heading level the search index carries. Defaults to
			 * `tocDepth`; a type page sets it deeper, so its member headings
			 * reach the palette while the on-this-page rail stays at the groups.
			 */
			searchDepth: z.number().optional(),

			/** Guide meta. */
			steps: z.number().optional(),
			minutes: z.number().optional(),

			/** Reference meta. */
			since: z.string().optional(),

			/*
			 * Library type page meta, written by the generator. `namespaces` is
			 * every Namespace the page folds, as the sources spell them (`List`,
			 * `NonEmptyList`, `IntegerList`, …); `aliases` is every refinement
			 * alias it hosts. `tests/stdlibMembers.spec.ts` checks the page's
			 * member manifest against the standard library, so that every Member
			 * has a page and no page claims a Member the library does not declare.
			 */
			namespaces: z.array(z.string()).default([]),
			aliases: z.array(z.string()).default([]),
			/** Protocols the type conforms to, with the `where` clause when conditional. */
			conformsTo: z.array(z.string()).default([]),
		})
		// NOTE: A key the schema does not name is an error, not a silent extra —
		// the retired fields (`nestUnder`, `member`, `kind`, `signature`,
		// `monoTitle`) would otherwise linger in frontmatter doing nothing.
		.strict()
		.transform((data) => ({
			...data,
			searchDepth: data.searchDepth ?? data.tocDepth,
		})),
})

export const collections = { docs }
