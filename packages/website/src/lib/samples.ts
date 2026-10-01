/*
 * The Essence samples on a documentation page, read one way for both readers:
 * the Shiki transformer in `astro.config.ts` and `tests/docsExamples.spec.ts`.
 *
 * A sample may open with one marker line, for the gate rather than the reader:
 *
 *   § fragment       the block is shown and never compiled, such as a
 *                    signature;
 *   § file: Name.es  the block is one file of several, which the blocks beside
 *                    it import by that name.
 *
 * The published page hides the line and captions a named file. A `§ …` comment
 * ending a `Terminal.print` line stays, since it shows the output.
 *
 * Nothing here imports Astro or Shiki, so the root `tsc` program can check it
 * on a fresh clone.
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

// The pages open every Essence fence at a line's start with no meta string.
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
