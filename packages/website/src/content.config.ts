import { glob } from "astro/loaders"
import { defineCollection, z } from "astro:content"

// A page's section is a closed set, since it is also the sidebar's grouping.
// A typo in frontmatter would otherwise invent a group nobody reaches.
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
			/**
			 * The labelled run the page sits under in the sidebar, such as
			 * `Basics`. `getSidebar` requires all or none of a section's
			 * top-level pages to have one, each a single run in `order`.
			 */
			group: z.string().optional(),
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
			 * Library type page meta, written by the generator: every Namespace
			 * the page folds, as the sources spell them, and every refinement
			 * alias it hosts. `tests/stdlibMembers.spec.ts` checks the manifest.
			 */
			namespaces: z.array(z.string()).default([]),
			aliases: z.array(z.string()).default([]),
			/** Protocols the type conforms to, with the `where` clause when conditional. */
			conformsTo: z.array(z.string()).default([]),
		})
		// A key the schema does not name is an error, so a dropped field
		// cannot linger in frontmatter.
		.strict()
		.transform((data) => ({
			...data,
			searchDepth: data.searchDepth ?? data.tocDepth,
		})),
})

export const collections = { docs }
