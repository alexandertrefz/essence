import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// What `vsce package` puts into the `.vsix`, as `vsce ls` lists it. A source
// the build bundles already ships inside `dist/extension.js`. Any file
// `.vscodeignore` forgets is published all the same.
const extensionDirectory = path.resolve(import.meta.dirname, "..")
// The pinned `@vscode/vsce`'s own bin, so neither `PATH` nor a download decides
// which vsce answers.
const vsceManifest = fileURLToPath(
	import.meta.resolve("@vscode/vsce/package.json"),
)
const { bin } = JSON.parse(readFileSync(vsceManifest, "utf8")) as {
	bin: { vsce: string }
}
const vsce = path.join(path.dirname(vsceManifest), bin.vsce)

function shippedFiles(): Array<string> {
	let listing = Bun.spawnSync(
		[process.execPath, vsce, "ls", "--no-dependencies"],
		{ cwd: extensionDirectory, stdout: "pipe", stderr: "pipe" },
	)

	if (listing.exitCode !== 0) {
		throw new Error(`vsce ls failed:\n${listing.stderr.toString()}`)
	}

	return listing.stdout
		.toString()
		.split("\n")
		.filter((line) => line !== "")
}

describe("The packaged extension", () => {
	// `server/` and `dist/` are what `bun run build` writes, so they are listed
	// only after a build. `tests/serverBundle.spec.ts` checks what they hold.
	it("ships exactly the files written to be shipped", () => {
		let written = shippedFiles()
			.filter((file) => !/^(server|dist)\//.test(file))
			.sort()

		expect(written).toEqual([
			"CHANGELOG.md",
			"LICENSE",
			"README.md",
			"icon.png",
			"icons/essence-file-dark.svg",
			"icons/essence-file-light.svg",
			"language-configuration.json",
			"package.json",
			"schemas/essence.schema.json",
			"snippets/essence.code-snippets",
			"syntaxes/essence.tmLanguage.json",
		])
	})
})
