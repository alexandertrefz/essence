import { readFileSync } from "node:fs"

import mdx from "@astrojs/mdx"
import { defineConfig } from "astro/config"

import { readSampleMarker } from "./src/lib/samples.ts"
import { SITE_URL } from "./src/lib/site.ts"

// Read as a file rather than imported: the TextMate grammar belongs to the
// editor extension's package.
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

// The file a `§ file: Name.es` block names, carried from the hook that reads
// the marker to the one that draws the caption. Keyed by `meta`, the one object
// Shiki shares between a block's hooks.
let sampleFiles = new WeakMap<object, string>()

export default defineConfig({
	site: SITE_URL,
	output: "static",

	// A port of its own, and no drifting off it. A browser caches redirects per
	// origin, so a dev server on another project's port would inherit its
	// redirects. `strictPort` fails instead of moving.
	server: { port: 4322, strictPort: true },

	integrations: [mdx()],
	vite: {
		build: {
			// WARNING: the CSS minifier's default target drops
			// `-webkit-backdrop-filter`, which Safari before 18 needs for every
			// frosted surface. This floor keeps the prefix in the bundle.
			cssTarget: ["chrome107", "edge107", "firefox104", "safari16"],
		},
	},
	markdown: {
		shikiConfig: {
			langs: [{ ...essenceGrammar, name: "essence", aliases: ["es"] }],
			// Both themes become CSS variables with no inline colour, so
			// `prefers-color-scheme` picks one in `src/styles/shiki.css`. Both
			// themes set a bare `foreground`, since an unthemed token gets none.
			themes: { light: essenceLight, dark: essenceDark },
			defaultColor: false,
			// A sample's marker line is for the docs-examples gate, read through
			// `src/lib/samples.ts`. It is dropped before highlighting, and a named
			// file becomes the block's caption.
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
