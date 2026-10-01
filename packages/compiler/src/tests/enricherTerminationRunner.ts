// The child half of `enricherTermination.spec.ts`: one job in on stdin, one
// word out. A run that never terminates can not be caught in the process that
// started it, so the spec runs it here under a wall clock.
//
// A `source` job analyses a whole Program. A `match` job hands
// `matchesTypeWithBindings` Type Parameters that were not alpha-renamed, the
// only way to reach the occurs check. Nothing is asserted here.
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
