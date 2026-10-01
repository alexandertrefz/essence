// An ordinary import, compiled by the Bun plugin registered in `essence.ts` and
// typed by `Survey.d.es.ts`. `surveyed` answers a `Future` in Essence, so here
// it answers a `Promise`, and calling it starts the requests.
import { type Outcome, surveyed } from "./survey/Survey.es"

// How many requests may be in flight at once, passed to `all(atMost:)` on the
// Essence side. An Integer crosses as a `bigint`.
const AT_MOST = 4n

function describe(outcome: Outcome): string {
	switch (outcome.$case) {
		case "Outcome#Answered":
			// `title` is an `Optional<String>` in Essence, so here it is the
			// string or `undefined`.
			return `${outcome.status} ${outcome.title ?? "(no title)"}`
		case "Outcome#Unreachable":
			return `  — ${outcome.reason}`
		case "Outcome#TooSlow":
			return "  — no answer within five seconds"
	}
}

let urls = process.argv.slice(2)

if (urls.length === 0) {
	console.error("usage: bun check.ts <address> [address …]")
	process.exit(2)
}

// One call and one await. The Module describes one piece of work per address,
// `all(atMost:)` combines them under a bound, and the boundary runs that and
// returns its promise.
let survey = await surveyed(urls, AT_MOST)

for (let report of survey.reports) {
	console.log(`${describe(report.outcome)}\t${report.url}`)
}

console.log(`${survey.successful} of ${survey.reports.length} answered`)

process.exit(survey.successful === BigInt(survey.reports.length) ? 0 : 1)
