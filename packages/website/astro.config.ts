import { readFileSync } from "node:fs"

import mdx from "@astrojs/mdx"
import { defineConfig } from "astro/config"

import { readSampleMarker } from "./src/lib/samples.ts"
import { SITE_URL } from "./src/lib/site.ts"

// NOTE: Read rather than `import … with { type: "json" }` so the grammar stays
// a plain file read — the TextMate grammar lives in another package and is the
// editor extension's own, not something this package may re-declare.
function readJson(relativePath: string): any {
	return JSON.parse(
		readFileSync(new URL(relativePath, import.meta.url), "utf8"),
	)
}

let essenceGrammar = readJson(
	"../vscode-extension/syntaxes/essence.tmLanguage.json",
)
let essenceLight = readJson("./src/lib/shiki/essence-light.json")
let essenceDark = readJson("./src/lib/shiki/essence-dark.json")

// NOTE: The file a `§ file: Name.es` block names, carried from the hook that
// reads the marker to the hook that draws the caption. Keyed by the hooks'
// `meta`, the one object Shiki hands every hook of a single block — the
// `options` beside it is copied between them.
let sampleFiles = new WeakMap<object, string>()

export default defineConfig({
	site: SITE_URL,
	output: "static",

	// NOTE: A port of its own, and a refusal to drift off it. Astro's default
	// is to step to the next free port when 4321 is taken, which lands the dev
	// server on whatever origin happens to be going — and a browser caches a
	// 301 per origin, so a redirect left behind by another project on that port
	// is inherited whole, before a single request reaches this server.
	// `strictPort` turns that silent move into a loud failure.
	server: { port: 4322, strictPort: true },

	integrations: [mdx()],
	vite: {
		build: {
			// NOTE: Load-bearing. The CSS minifier drops a `-webkit-` prefix it
			// believes the target no longer needs, and its default target is new
			// enough to think that of `-webkit-backdrop-filter` — which silently
			// un-frosted the header, mobile menu, TOC bar and search overlay on
			// every Safari before 18, where the unprefixed property first
			// shipped. Naming the floor keeps the prefixed declarations in the
			// bundle. Verify with:
			//   grep -ro '\-webkit-backdrop-filter' dist | wc -l   # expect 4
			cssTarget: ["chrome107", "edge107", "firefox104", "safari16"],
		},
	},
	markdown: {
		shikiConfig: {
			langs: [{ ...essenceGrammar, name: "essence", aliases: ["es"] }],
			// NOTE: `defaultColor: false` emits both themes as CSS variables and
			// no inline colour, so `prefers-color-scheme` picks the palette —
			// see `src/styles/shiki.css`. It also means an unthemed token has no
			// colour at all, which is why both themes set a bare `foreground`.
			themes: { light: essenceLight, dark: essenceDark },
			defaultColor: false,
			// NOTE: A sample's marker line is written for the docs-examples
			// gate, not for the reader — see `src/lib/samples.ts`, which both
			// of them read it through. It is dropped before highlighting, and a
			// file's name becomes the block's caption, so a page that splits a
			// program into modules still says which block is which file.
			transformers: [
				{
					name: "essence:sample-markers",
					preprocess(code, options) {
						if (
							options.lang !== "essence" &&
							options.lang !== "es"
						) {
							return
						}

						let marker = readSampleMarker(code)

						if (marker.file !== undefined) {
							sampleFiles.set(this.meta, marker.file)
						}

						return marker.code
					},
					root(hast) {
						let file = sampleFiles.get(this.meta)
						let pre = hast.children[0]

						if (file === undefined || pre?.type !== "element") {
							return
						}

						hast.children = [
							{
								type: "element",
								tagName: "figure",
								properties: { className: ["code-file"] },
								children: [
									{
										type: "element",
										tagName: "figcaption",
										properties: {
											className: ["code-file__name"],
										},
										children: [
											{ type: "text", value: file },
										],
									},
									pre,
								],
							},
						]
					},
				},
			],
		},
	},
})
