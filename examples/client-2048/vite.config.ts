import { essence } from "@essence-lang/client/vite-plugin"
import { defineConfig } from "vite"

// NOTE: The one line the page needs. With the plugin in place, `import … from
// "./Game.es"` is an ordinary import: Vite asks the plugin for the file's text,
// the plugin compiles the Module graph behind it and serves it as marshalled
// JavaScript, and Vite bundles, splits and hot-reloads it like anything else.
export default defineConfig({
	plugins: [essence()],
})
