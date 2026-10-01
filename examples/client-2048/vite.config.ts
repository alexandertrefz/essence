import { essence } from "@essence-lang/client/vite-plugin"
import { defineConfig } from "vite"

// The one line the page needs. With the plugin, importing `Game.es` is an
// ordinary import. The plugin compiles the Module graph to marshalled
// JavaScript, which Vite bundles and hot-reloads like anything else.
export default defineConfig({
	plugins: [essence()],
})
