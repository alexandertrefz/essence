import { execFileSync } from "node:child_process"

import { PUBLISHED_PACKAGES, stageDirectory } from "./packages"
import { stagePackages } from "./stage"

// Stages afresh, then publishes. See "Publishing packages" in DEVELOPMENT.md.
//
// Staged manifests carry `publishConfig.access: "public"`, so a plain
// `npm publish` works after `npm login`, once the @essence-lang organisation
// exists on npm.

let dryRun = process.argv.includes("--dry-run")

stagePackages()

for (let { directory } of PUBLISHED_PACKAGES) {
	console.log(`\npublishing ${directory}${dryRun ? " (dry run)" : ""}…`)
	execFileSync("npm", ["publish", ...(dryRun ? ["--dry-run"] : [])], {
		cwd: stageDirectory(directory),
		stdio: "inherit",
	})
}

console.log(
	dryRun
		? "\ndry run complete — nothing reached the registry"
		: `\npublished ${PUBLISHED_PACKAGES.length} packages`,
)
