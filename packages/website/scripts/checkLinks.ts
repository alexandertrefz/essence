// Checks every internal link in a built site: the page must exist and, when the
// link carries a #fragment, an element with that id must exist on the page.
//
// Usage: bun scripts/checkLinks.ts <dist-dir> [--redirects <netlify.toml>]
//        bun run check:links     (dist/ against ../../netlify.toml)
//
// Astro's default `build.format: "directory"` writes /docs/x/y as
// dist/docs/x/y/index.html; a file-format build (dist/docs/x/y.html) is
// accepted too. A redirect source from netlify.toml counts as a page; its
// fragment is checked against the redirect's target. A link that is only a
// #fragment is checked against the page it stands on.
//
// Exit 0 when every link resolves; 1 otherwise, with one line per broken link.
//
// NOTE: It reads the BUILT site rather than the pages' sources, because an id
// is not something a page's source spells: a heading's comes from the slugger,
// a library member's from the generator, a CLI flag's from a `<span>` — and
// the link a reader follows is only broken or not once all of them have run.
// The deploy runs it after the build, so a broken link fails the deploy rather
// than reaching a reader.

import { readdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"

let [distArgument, ...rest] = process.argv.slice(2)

if (distArgument === undefined) {
	console.error(
		"usage: bun scripts/checkLinks.ts <dist-dir> [--redirects <netlify.toml>]",
	)
	process.exit(2)
}

let dist = path.resolve(distArgument)
let redirectsIndex = rest.indexOf("--redirects")
let redirects = new Map<string, string>()

if (redirectsIndex !== -1) {
	let toml = readFileSync(rest[redirectsIndex + 1] as string, "utf8")

	for (let block of toml.split("[[redirects]]").slice(1)) {
		let from = /from\s*=\s*"([^"]+)"/.exec(block)?.[1]
		let to = /to\s*=\s*"([^"]+)"/.exec(block)?.[1]

		if (from !== undefined && to !== undefined) {
			redirects.set(normalise(from), normalise(to))
		}
	}
}

function normalise(url: string): string {
	return (
		url
			.replace(/\/index\.html$/, "")
			.replace(/\.html$/, "")
			.replace(/\/+$/, "") || "/"
	)
}

function walk(directory: string): Array<string> {
	return readdirSync(directory).flatMap((name) => {
		let full = path.join(directory, name)

		return statSync(full).isDirectory()
			? walk(full)
			: full.endsWith(".html")
				? [full]
				: []
	})
}

function urlOf(file: string): string {
	return normalise(`/${path.relative(dist, file).split(path.sep).join("/")}`)
}

function decodeEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
}

let files = walk(dist)
let ids = new Map<string, Set<string>>()
let html = new Map<string, string>()

for (let file of files) {
	let text = readFileSync(file, "utf8")
	let url = urlOf(file)

	html.set(url, text)
	ids.set(
		url,
		new Set(
			[...text.matchAll(/\sid="([^"]+)"/g)].map((match) =>
				decodeEntities(match[1] as string),
			),
		),
	)
}

let broken = 0
let seen = new Set<string>()

for (let [from, text] of html) {
	for (let match of text.matchAll(/\shref="([^"]+)"/g)) {
		let href = decodeEntities(match[1] as string)
		let samePage = href.startsWith("#")

		if (
			(!samePage && !href.startsWith("/")) ||
			href.startsWith("//") ||
			/\.(css|js|svg|png|ico|woff2?|xml|json|txt)(\?|#|$)/.test(href)
		) {
			continue
		}

		let [rawPath = "", fragment] = href.split("#")
		let target = samePage
			? from
			: normalise(rawPath.split("?")[0] as string)

		target = redirects.get(target) ?? target

		let key = `${from} → ${href}`

		if (seen.has(key)) {
			continue
		}

		seen.add(key)

		if (!ids.has(target)) {
			broken++
			console.log(`MISSING PAGE    ${from}  →  ${href}`)

			continue
		}

		if (fragment && !ids.get(target)?.has(decodeURIComponent(fragment))) {
			broken++
			console.log(`MISSING ANCHOR  ${from}  →  ${href}`)
		}
	}
}

console.log(
	`\n${files.length} pages, ${seen.size} distinct internal links, ${broken} broken`,
)
process.exit(broken === 0 ? 0 : 1)
