// NOTE: An ordinary import. The Bun plugin registered in `essence.ts` (see
// `bunfig.toml`) compiles the Module graph behind it and serves it as
// marshalled JavaScript. `surveyed` answers a `Future` in Essence, so what it
// answers here is a `Promise`: calling it is what puts the requests in flight,
// and `Survey.d.es.ts` beside the source is what TypeScript reads its Types
// from.
import { type Outcome, surveyed } from "./survey/Survey.es"

// NOTE: How many requests are allowed in flight at once. It is the argument to
// `all(atMost:)` on the Essence side, and the one number that decides whether
// twenty addresses are twenty waits or five. An Integer crosses as a `bigint`.
const AT_MOST = 4n

function describe(outcome: Outcome): string {
	switch (outcome.$case) {
		case "Outcome#Answered":
			// NOTE: `title` is an `Optional<String>` in Essence, so it is the
			// string or `undefined` here — there is no second spelling of
			// "this page has no title".
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

// NOTE: One call and one await. Everything concurrent about this program is on
// the other side of it: the Module describes one piece of work per address,
// `all(atMost:)` folds them into a single description with a bound, and the
// boundary starts one run of that and hands back its promise.
let survey = await surveyed(urls, AT_MOST)

for (let report of survey.reports) {
	console.log(`${describe(report.outcome)}\t${report.url}`)
}

console.log(`${survey.successful} of ${survey.reports.length} answered`)

process.exit(survey.successful === BigInt(survey.reports.length) ? 0 : 1)
