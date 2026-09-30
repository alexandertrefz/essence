import { writeFileSync } from "node:fs"
import * as path from "node:path"

import {
	BASELINE_PATH,
	driftOf,
	formatBaseline,
	linesOf,
	lowerBaseline,
	readBaseline,
	repositoryFindings,
} from "./commentProse"
import { REPOSITORY_ROOT } from "./publishing/packages"

// Lowers `scripts/tests/commentProse.baseline.json` to what the comments break
// now, once a comment has been fixed. A count that rose is refused, so the
// baseline only ever shrinks unless somebody raises it by hand.

let baseline = readBaseline()
let { next, lowered, refused } = lowerBaseline(
	baseline,
	driftOf(await repositoryFindings(), baseline),
)
let baselineFile = path.relative(REPOSITORY_ROOT, BASELINE_PATH)

for (let entry of lowered) {
	console.log(
		`lowered ${entry.file} '${entry.rule}': ${entry.baseline} -> ${entry.found}`,
	)
}

for (let entry of refused) {
	console.log(
		`refused ${entry.file} '${entry.rule}': ${entry.baseline} -> ${entry.found}, on ${linesOf(entry)}. Fix the comment, or raise the count by hand in ${baselineFile}.`,
	)
}

if (lowered.length > 0) {
	writeFileSync(BASELINE_PATH, formatBaseline(next))
}

console.log(
	`${lowered.length} count${lowered.length === 1 ? "" : "s"} lowered, ${refused.length} refused`,
)

if (refused.length > 0) {
	process.exitCode = 1
}
