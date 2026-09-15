/*
 * The Essence samples on a documentation page, read the one way both of their
 * readers need: the Shiki transformer in `astro.config.ts`, which draws them,
 * and `tests/docsExamples.spec.ts`, which compiles, formats and runs them.
 *
 * A sample may open with one marker line, written for the gate and never
 * meant for a reader:
 *
 *   § fragment       the block is shown and never compiled — a signature, or
 *                    one arm of a construct taught in full elsewhere;
 *   § file: Name.es  the block is one file of several, and the blocks beside
 *                    it on the same page import it by that name.
 *
 * The published page hides the line and turns a file's name into the block's
 * caption. The `§ …` comments at the end of a `Terminal.print` line stay: they
 * are the output a reader would see, written where the reader looks for it.
 *
 * NOTE: Nothing here imports Astro or Shiki. The root `tsc` program reaches
 * this file through the spec, and it has to type-check on a fresh clone.
 */

export const FRAGMENT_MARKER = "§ fragment"

const FILE_MARKER = /^§ file: (\S+\.es)$/

/** What a block's first line says about it, and the block without that line. */
export interface SampleMarker {
	/** The source as a reader sees it and the formatter holds it. */
	code: string
	fragment: boolean
	/** The file name sibling blocks import this one by. */
	file: string | undefined
}

export interface Sample extends SampleMarker {
	/** The page line the opening fence is on, counted from 1. */
	line: number
	/**
	 * What the program prints, one entry per `Terminal.print(…)` or
	 * `Terminal.inspect(…)` line that ends in a `§ …` comment, in source order.
	 */
	expected: Array<string>
}

export function readSampleMarker(code: string): SampleMarker {
	let newline = code.indexOf("\n")
	let firstLine = (newline === -1 ? code : code.slice(0, newline)).trim()
	let rest = newline === -1 ? "" : code.slice(newline + 1)

	if (firstLine === FRAGMENT_MARKER) {
		return { code: rest, fragment: true, file: undefined }
	}

	let named = FILE_MARKER.exec(firstLine)

	if (named !== null) {
		return { code: rest, fragment: false, file: named[1] }
	}

	return { code, fragment: false, file: undefined }
}

// NOTE: The fence as `SP/checkSamples.ts` read it while the pages were written
// — every block those pages were proven against is the block this finds. The
// pages open every Essence fence at the start of a line with no meta string,
// so the pattern needs no more than that.
const ESSENCE_FENCE = /```essence[^\n]*\n([\s\S]*?)```/g

const EXPECTED_OUTPUT = /Terminal\.(?:print|inspect)\(.*\)\s*§ (.*)$/

export function essenceSamples(page: string): Array<Sample> {
	return [...page.matchAll(ESSENCE_FENCE)].map((match) => {
		let marker = readSampleMarker(match[1] as string)

		return {
			...marker,
			line: page.slice(0, match.index).split("\n").length,
			expected: marker.code
				.split("\n")
				.map((line) => EXPECTED_OUTPUT.exec(line)?.[1]?.trim())
				.filter((text) => text !== undefined),
		}
	})
}
