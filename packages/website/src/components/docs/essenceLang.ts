/*
 * The grammar and the two themes, for the places on a reference page where
 * essence appears outside a Markdown fence — the signature card and a
 * parameter's type.
 *
 * NOTE: `astro:components`' <Code> builds its own highlighter and cannot read
 * `markdown.shikiConfig`, so this pairing is repeated rather than shared. It is
 * the same trio `astro.config.ts` loads; if the grammar path or the theme files
 * move, both places change.
 *
 * NOTE: Imported, not `readFileSync(new URL(…, import.meta.url))`. The build
 * bundles this module into `dist/.prerender/chunks/`, where `import.meta.url`
 * is the chunk's own path and every relative read misses. An import is resolved
 * at build time and inlined, so it cannot.
 */

import essenceGrammar from "../../../../vscode-extension/syntaxes/essence.tmLanguage.json"
import essenceDark from "../../lib/shiki/essence-dark.json"
import essenceLight from "../../lib/shiki/essence-light.json"

export const ESSENCE_LANG: any = {
	...essenceGrammar,
	name: "essence",
	aliases: ["es"],
}

export const ESSENCE_THEMES: any = {
	light: essenceLight,
	dark: essenceDark,
}
