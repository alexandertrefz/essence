import { execFileSync } from "node:child_process"

import { PUBLISHED_PACKAGES, stageDirectory } from "./packages"
import { stagePackages } from "./stage"

// NOTE: Publishing re-stages rather than trusting whatever a previous run
// left behind — staging is seconds, and what goes to the registry should be
// what the tree says right now. The smoke test is NOT run here, because it
// wants the network and a couple of minutes; `bun run publish:smoke` is the
// step before this one, and PUBLISHING.md is the checklist.
//
// Each staged manifest carries `publishConfig.access: "public"`, so a plain
// `npm publish` is enough — but it does need `npm login` to have happened,
// and the @essence organisation to exist on npm.

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
