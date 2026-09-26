import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import { analyseSource } from "@essence-lang/compiler/analysis"
import { renderDiagnostics } from "@essence-lang/compiler/diagnostics/render"
import { fixturePath } from "@essence-lang/fixtures"

// NOTE: A report on `/docs/reference/diagnostics` copied from a showcase in
// `packages/fixtures/files/diagnostics/` takes that showcase's name and is held
// to what it reports today. A report written for the page takes another name.

const DIAGNOSTICS_PAGE = path.resolve(
	import.meta.dirname,
	"../src/content/docs/reference/diagnostics.mdx",
)

const SHOWCASE_DIRECTORY = fixturePath("diagnostics")

const HEADING = /╭─┤ (\S+\.es):(\d+:\d+) │/

let showcaseNames = readdirSync(SHOWCASE_DIRECTORY)
	.filter((name) => name.endsWith(".es"))
	.sort()

let page = readFileSync(DIAGNOSTICS_PAGE, "utf8")

let quotedReports = [
	...page.matchAll(
		/<div class="error-output">\n\n```\n([\s\S]*?)\n```\n\n<\/div>/g,
	),
].map((match) => match[1])

type Quoted = { report: string; fileName: string; location: string }

let headed: Array<Quoted> = quotedReports.flatMap((report) => {
	let heading = report.match(HEADING)

	return heading === null
		? []
		: [{ report, fileName: heading[1], location: heading[2] }]
})

let captured = headed.filter(({ fileName }) => showcaseNames.includes(fileName))

let pageWritten = headed.filter(
	({ fileName }) => !showcaseNames.includes(fileName),
)

let reportsByShowcase = new Map<string, Array<string>>()

// NOTE: With the tests, as `diagnosticShowcase.spec.ts` analyses a showcase, so
// a report only `essence test` gives can be quoted too.
function reportsOf(fileName: string): Array<string> {
	let known = reportsByShowcase.get(fileName)

	if (known !== undefined) {
		return known
	}

	let source = readFileSync(path.join(SHOWCASE_DIRECTORY, fileName), "utf8")
	let { diagnostics } = analyseSource(source, undefined, { tests: true })

	let reports = diagnostics.map((diagnostic) => {
		let rendered = renderDiagnostics([diagnostic], source, fileName, {
			color: false,
		})

		// NOTE: The page quotes a report without the tally that closes a
		// rendering.
		return rendered.slice(0, rendered.lastIndexOf("\n\n"))
	})

	reportsByShowcase.set(fileName, reports)

	return reports
}

// NOTE: When no report matches, compare with the one at the same place, or else
// with the same message, so a drift reads as a diff of one report.
function counterpartOf(quoted: string, reports: Array<string>): string {
	let opening = (report: string, lines: number) =>
		report.split("\n").slice(0, lines).join("\n")

	for (let lines of [Infinity, 3, 2]) {
		let found = reports.find(
			(report) => opening(report, lines) === opening(quoted, lines),
		)

		if (found !== undefined) {
			return found
		}
	}

	return reports.join("\n\n")
}

function withoutFileName(report: string): string {
	return report.replace(HEADING, "╭─┤ $2 │")
}

describe("Diagnostic Reports", () => {
	it("should read every report on the page", () => {
		// NOTE: A guard on the parsing, which would otherwise turn this gate
		// into a no-op by matching nothing.
		expect(quotedReports.length).toBe(
			page.split('<div class="error-output">').length - 1,
		)
		expect(captured.length).toBeGreaterThan(0)
	})

	it("should quote every report copied from a showcase under its name", () => {
		let renamed = pageWritten.flatMap(({ report, fileName, location }) =>
			showcaseNames
				.filter((showcase) =>
					reportsOf(showcase).some(
						(shown) =>
							withoutFileName(shown) === withoutFileName(report),
					),
				)
				.map(
					(showcase) => `${fileName}:${location} copies ${showcase}`,
				),
		)

		expect(renamed).toEqual([])
	})

	for (let { report, fileName, location } of captured) {
		it(`should quote ${fileName}:${location} as the showcase reports it`, () => {
			expect(counterpartOf(report, reportsOf(fileName))).toBe(report)
		})
	}
})
