// NOTE: The child half of `enricherTermination.spec.ts` — one job in on stdin,
// one word out. It exists so the spec can put a WALL CLOCK around work that
// might not come back: a run that does not terminate can not be caught in the
// process that started it, and a `bun test` that inherits the spin reports
// nothing at all.
//
// Two jobs, because the two protections being guarded sit at different depths.
// A `source` job analyses a whole Program, which is what a reader would hit; a
// `match` job hands `matchesTypeWithBindings` a raw context whose Type
// Parameters were NOT alpha-renamed, which is the only way to reach the occurs
// check while the renaming that normally keeps it out of the way is in place.
//
// Nothing is asserted here. Whether the analysis reports Diagnostics, and
// whether the match answers yes or no, are the spec's business; this only has to
// come back.
import type { common } from "@essence-lang/interfaces"

import { analyseSource } from "../analysis"
import { matchesTypeWithBindings } from "../helpers/types"

type Job =
	| { kind: "source"; source: string }
	| {
			kind: "match"
			pattern: common.Type
			subject: common.Type
			bindable: Array<string>
	  }

let job = JSON.parse(await Bun.stdin.text()) as Job

if (job.kind === "source") {
	analyseSource(job.source, "/termination.es")
} else {
	matchesTypeWithBindings(job.pattern, job.subject, {
		bindableNames: new Set(job.bindable),
		bindings: new Map(),
	})
}

process.stdout.write("returned")
