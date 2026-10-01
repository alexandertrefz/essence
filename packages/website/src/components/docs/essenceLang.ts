/*
 * The grammar and the two themes, for Essence outside a Markdown fence, such as
 * the signature card. `<Code>` cannot read `markdown.shikiConfig`, so this
 * repeats what `astro.config.ts` loads, and both change together.
 *
 * Imported rather than read: the build bundles this module into a chunk, where
 * a path relative to `import.meta.url` misses.
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
