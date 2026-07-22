// Port of ariadne's report renderer (`src/report/write.rs`).
// https://codeberg.org/zesterer/ariadne — MIT licensed.
//
// The upstream file opens with a warning that applies equally here:
//
//   A WARNING, FOR ALL YE WHO VENTURE IN HERE
//   - This code is complex and has a lot of implicit invariants
//   - Yes, it has some bugs
//   - Yes, it needs rewriting
//   - No, you are not expected to understand it.
//
// This port intentionally follows the upstream logic statement-by-statement
// (bugs included) so that its output stays verifiable against the upstream
// snapshot test suite.

import { type Color, paint, stripAnsi } from "./color"
import type { Config } from "./config"
import {
	arrowBend,
	asciiCharacters,
	unicodeCharacters,
	vbarCharacter,
} from "./draw"
import type { Label } from "./label"
import { type Report, reportKindColor, reportKindName } from "./report"
import type { Cache, Line, Location, Source } from "./source"
import { type Range, rangeContains, rangeLength } from "./span"

interface LabelInfo {
	kind: "inline" | "multiline"
	charSpan: Range
	label: Label<never>
	startLine: number
	endLine: number
}

interface SourceGroup<Id> {
	sourceId: Id | undefined
	charSpan: Range
	displayRange: Range
	labels: Array<LabelInfo>
}

interface LineLabel {
	column: number
	label: LabelInfo
	multi: number | null
	drawMessage: boolean
}

class Writer {
	private parts: Array<string> = []

	write(text: string): void {
		this.parts.push(text)
	}

	writeLine(text = ""): void {
		this.parts.push(`${text}\n`)
	}

	toString(): string {
		return this.parts.join("")
	}
}

// Mirrors Rust's `!x` on usize keys, which is used to invert sort order:
// preserves that any inverted key compares greater than any regular key.
function inverted(value: number): number {
	return Number.MAX_SAFE_INTEGER - value
}

function compareKeys(a: Array<number>, b: Array<number>): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i] !== b[i]) {
			return a[i] < b[i] ? -1 : 1
		}
	}

	return 0
}

function stableSortByKey<T>(
	items: Array<T>,
	key: (item: T) => Array<number>,
): void {
	items.sort((a, b) => compareKeys(key(a), key(b)))
}

// Returns the first item with the minimal key, like Rust's `min_by_key`.
function minByKey<T>(
	items: Array<T>,
	key: (item: T) => Array<number>,
): T | null {
	let best: T | null = null
	let bestKey: Array<number> | null = null

	for (let item of items) {
		let itemKey = key(item)

		if (bestKey === null || compareKeys(itemKey, bestKey) < 0) {
			best = item
			bestKey = itemKey
		}
	}

	return best
}

function lastOffset(label: LabelInfo): number {
	return Math.max(label.charSpan.end - 1, label.charSpan.start)
}

function labelDisplayRange(label: LabelInfo, config: Config): Range {
	return {
		start: Math.max(0, label.startLine - config.contextLines),
		end: label.endLine + config.contextLines + 1,
	}
}

function countCodePoints(text: string): number {
	return [...text].length
}

function numberOfDigits(value: number): number {
	return String(Math.max(0, Math.trunc(value))).length
}

function displayName<Id>(cache: Cache<Id>, id: Id): string {
	return cache.display(id) ?? "<unknown>"
}

function fetchSource<Id>(cache: Cache<Id>, id: Id): [Source, string] | null {
	let name = displayName(cache, id)

	try {
		return [cache.fetch(id), name]
	} catch (error) {
		console.error(`Unable to fetch source ${name}: ${error}`)
		return null
	}
}

function getSourceGroups<Id>(
	report: Report<Id>,
	cache: Cache<Id>,
): Array<SourceGroup<Id>> {
	let labels: Array<[LabelInfo, Id | undefined]> = []

	for (let label of report.labels) {
		let labelSource = label.span.sourceId

		let fetched = fetchSource(cache, labelSource as Id)
		if (fetched === null) {
			continue
		}
		let [source] = fetched

		let givenSpan = { start: label.span.start, end: label.span.end }
		let charSpan: Range
		let startLine: number
		let endLine: number

		if (report.config.indexType === "char") {
			let startLocation = source.getOffsetLine(givenSpan.start)
			if (startLocation === null) {
				continue
			}

			if (givenSpan.start >= givenSpan.end) {
				endLine = startLocation.lineIndex
			} else {
				let endLocation = source.getOffsetLine(givenSpan.end - 1)
				if (endLocation === null) {
					continue
				}
				endLine = endLocation.lineIndex
			}

			charSpan = givenSpan
			startLine = startLocation.lineIndex
		} else {
			let startLocation = source.getUtf16Line(givenSpan.start)
			if (startLocation === null) {
				continue
			}
			let lineText = source.getLineText(startLocation.line)

			let charactersBeforeStart = countCodePoints(
				lineText.slice(
					0,
					Math.min(startLocation.columnIndex, lineText.length),
				),
			)
			let startCharOffset =
				startLocation.line.offset + charactersBeforeStart

			if (givenSpan.start >= givenSpan.end) {
				charSpan = { start: startCharOffset, end: startCharOffset }
				startLine = startLocation.lineIndex
				endLine = startLocation.lineIndex
			} else {
				// We can subtract 1 from the end, because getUtf16Line doesn't
				// actually index into the text.
				let endPosition = givenSpan.end - 1
				let endLocation = source.getUtf16Line(endPosition)
				if (endLocation === null) {
					continue
				}
				let endLineText = source.getLineText(endLocation.line)
				// Have to add 1 back now, so we don't cut a character in two.
				let charactersBeforeEnd = countCodePoints(
					endLineText.slice(0, endLocation.columnIndex + 1),
				)
				let endCharOffset =
					endLocation.line.offset + charactersBeforeEnd

				charSpan = { start: startCharOffset, end: endCharOffset }
				startLine = startLocation.lineIndex
				endLine = endLocation.lineIndex
			}
		}

		let labelInfo: LabelInfo = {
			kind: startLine === endLine ? "inline" : "multiline",
			charSpan,
			label: label as Label<never>,
			startLine,
			endLine,
		}

		labels.push([labelInfo, labelSource])
	}

	stableSortByKey(labels, ([info]) => [
		info.label.order,
		info.endLine,
		info.startLine,
	])

	let groups: Array<SourceGroup<Id>> = []

	for (let [label, sourceId] of labels) {
		let group = groups[groups.length - 1]

		if (
			group !== undefined &&
			group.sourceId === sourceId &&
			(group.labels.length === 0 ||
				group.labels[group.labels.length - 1].endLine <= label.endLine)
		) {
			group.charSpan.start = Math.min(
				group.charSpan.start,
				label.charSpan.start,
			)
			group.charSpan.end = Math.max(
				group.charSpan.end,
				label.charSpan.end,
			)
			let displayRange = labelDisplayRange(label, report.config)
			group.displayRange.start = Math.min(
				group.displayRange.start,
				displayRange.start,
			)
			group.displayRange.end = Math.max(
				group.displayRange.end,
				displayRange.end,
			)
			group.labels.push(label)
		} else {
			groups.push({
				sourceId,
				charSpan: { ...label.charSpan },
				displayRange: labelDisplayRange(label, report.config),
				labels: [label],
			})
		}
	}

	return groups
}

export function writeReport<Id>(report: Report<Id>, cache: Cache<Id>): string {
	let config = report.config
	let w = new Writer()
	let draw =
		config.charSet === "unicode" ? unicodeCharacters : asciiCharacters

	const labelColor = (label: LabelInfo): Color | null =>
		config.filterColor(label.label.color)

	// --- Header ---

	let kindColor = reportKindColor(report.kind, config)

	// NOTE: The code gets a line of its own above the header, in the same
	// color as `Note` and `Help`, rather than sharing the kind's line and
	// color as upstream does. It is a lookup key rather than part of the
	// sentence, and on the header line it competes with the word that says
	// whether this is an error at all.
	if (report.code !== null) {
		w.writeLine(paint(`[${report.code}]`, config.noteColor()))
	}

	w.writeLine(
		`${paint(reportKindName(report.kind), kindColor)}: ${report.message ?? ""}`,
	)

	let groups = getSourceGroups(report, cache)

	// Line number maximum width
	let lineNumberWidth = groups.reduce(
		(maximum, group) =>
			Math.max(maximum, numberOfDigits(group.displayRange.end)),
		0,
	)

	const marginCharacter = (character: string): string =>
		paint(character, config.marginColor())

	const writeMargin = (
		index: number,
		isSourceLine: boolean,
		isEllipsis: boolean,
	): void => {
		if (groups.length === 0) {
			return
		}

		let lineNumberMargin: string
		if (isSourceLine && !isEllipsis) {
			lineNumberMargin = paint(
				`${String(index + 1).padStart(lineNumberWidth)} ${draw.vbar}`,
				config.marginColor(),
			)
		} else {
			lineNumberMargin = paint(
				`${" ".repeat(lineNumberWidth + 1)}${vbarCharacter(draw, isEllipsis)}`,
				config.skippedMarginColor(),
			)
		}

		w.write(` ${lineNumberMargin} `)
	}

	const writeSpacerLine = (): void => {
		if (!config.compact) {
			w.writeLine(
				`${" ".repeat(lineNumberWidth + 2)}${marginCharacter(draw.vbar)}`,
			)
		}
	}

	// --- Source sections ---

	for (let [groupIndex, group] of groups.entries()) {
		let fetched = fetchSource(cache, group.sourceId as Id)
		if (fetched === null) {
			// `fetchSource` has already reported the error.
			continue
		}
		let [source, sourceName] = fetched

		// File name & reference
		let locationOffset: number
		let locationIndexType: "char" | "utf16"
		if (group.sourceId === report.span.sourceId) {
			locationOffset = report.span.start
			locationIndexType = config.indexType
		} else {
			// This has already been converted from utf16 to chars, if applicable.
			locationOffset = group.labels[0].charSpan.start
			locationIndexType = "char"
		}

		let location: Location | null
		if (locationIndexType === "char") {
			location = source.getOffsetLine(locationOffset)
		} else {
			let utf16Location = source.getUtf16Line(locationOffset)

			if (utf16Location === null) {
				location = null
			} else {
				let lineText = source.getLineText(utf16Location.line)
				location = {
					line: utf16Location.line,
					lineIndex: utf16Location.lineIndex,
					columnIndex: countCodePoints(
						lineText.slice(
							0,
							Math.min(
								utf16Location.columnIndex,
								lineText.length,
							),
						),
					),
				}
			}
		}

		let locationText =
			location === null
				? ":?:?"
				: `${sourceName}:${location.lineIndex + 1 + source.displayLineOffset}:${location.columnIndex + 1}`

		let cornerCharacter: string
		if (groupIndex === 0) {
			cornerCharacter = draw.ltop
		} else {
			writeSpacerLine()
			cornerCharacter = draw.lcross
		}

		w.writeLine(
			`${paint(" ".repeat(lineNumberWidth + 2), config.marginColor())}${marginCharacter(cornerCharacter)}${marginCharacter(draw.hbar)}${marginCharacter(draw.lbox)} ${locationText} ${marginCharacter(draw.rbox)}`,
		)

		if (!config.compact) {
			writeSpacerLine()
		}

		// Generate a list of multi-line labels
		let multiLabels = group.labels.filter(
			(label) => label.kind === "multiline",
		)
		// Sort them by length, descending. (A stable sort keeps the results
		// reproducible.)
		multiLabels.sort(
			(a, b) => rangeLength(b.charSpan) - rangeLength(a.charSpan),
		)

		// Since we're filtering a sorted array, this one is also sorted.
		let multiLabelsWithMessage = multiLabels.filter(
			(label) => label.label.message !== null,
		)

		// However, we may want to re-sort it:
		if (config.minimiseCrossings && multiLabelsWithMessage.length > 1) {
			// There is no total ordering to labels, so just spin around a bunch
			// rearranging labels making tiny improvements. Crap bubble sort,
			// basically.
			let count = multiLabelsWithMessage.length
			let iterations = count * count * 2

			for (let iteration = 0; iteration < iterations; iteration++) {
				let i = iteration % (count - 1)
				let a = multiLabelsWithMessage[i]
				let b = multiLabelsWithMessage[i + 1]

				let proA =
					Number(a.charSpan.start < b.charSpan.start) +
					Number(a.charSpan.end > b.charSpan.end)
				let proB =
					Number(b.charSpan.start < a.charSpan.start) +
					Number(b.charSpan.end > a.charSpan.end)

				if (proA < proB) {
					multiLabelsWithMessage[i] = b
					multiLabelsWithMessage[i + 1] = a
				}
			}
		}

		const writeMarginAndArrows = (
			index: number,
			isSourceLine: boolean,
			isEllipsis: boolean,
			reportRow: [number, boolean] | null,
			lineLabels: Array<LineLabel>,
			marginLabel: LineLabel | null,
		): void => {
			writeMargin(index, isSourceLine, isEllipsis)

			// Multi-line margins
			let columnCount =
				multiLabelsWithMessage.length +
				(multiLabelsWithMessage.length > 0 ? 1 : 0)

			for (let column = 0; column < columnCount; column++) {
				let corner: [LabelInfo, boolean] | null = null
				let hbar: LabelInfo | null = null
				let vbar: LabelInfo | null = null
				let marginPointer: [LineLabel, boolean] | null = null

				let multiLabel =
					column < multiLabelsWithMessage.length
						? multiLabelsWithMessage[column]
						: null
				let lineSpan = (source.line(index) as Line).span

				let innerCount = Math.min(
					column + 1,
					multiLabelsWithMessage.length,
				)
				for (let i = 0; i < innerCount; i++) {
					let label = multiLabelsWithMessage[i]
					let margin =
						marginLabel !== null && marginLabel.label === label
							? marginLabel
							: null

					if (
						label.charSpan.start < lineSpan.end &&
						label.charSpan.end > lineSpan.start
					) {
						let isParent = i !== column
						let isStart = rangeContains(
							lineSpan,
							label.charSpan.start,
						)
						let isEnd = rangeContains(lineSpan, lastOffset(label))
						let skipMarginCheck = false

						if (margin !== null && isSourceLine) {
							marginPointer = [margin, isStart]
						} else if (!isStart && (!isEnd || isSourceLine)) {
							if (vbar === null && !isParent) {
								vbar = label
							}
						} else if (reportRow !== null) {
							let [reportRowIndex, isArrow] = reportRow
							let foundRow = lineLabels.findIndex(
								(lineLabel) => lineLabel.label === label,
							)
							let labelRow = foundRow === -1 ? 0 : foundRow

							if (reportRowIndex === labelRow) {
								if (margin !== null) {
									vbar = column === i ? margin.label : null
									if (isStart) {
										skipMarginCheck = true
									}
								}

								if (!skipMarginCheck) {
									if (isArrow) {
										hbar = label
										if (!isParent) {
											corner = [label, isStart]
										}
									} else if (!isStart) {
										if (vbar === null && !isParent) {
											vbar = label
										}
									}
								}
							} else {
								if (
									vbar === null &&
									!isParent &&
									isStart !== reportRowIndex < labelRow
								) {
									vbar = label
								}
							}
						}

						if (
							!skipMarginCheck &&
							marginLabel !== null &&
							isEnd &&
							isSourceLine &&
							label === marginLabel.label &&
							column > i
						) {
							hbar = marginLabel.label
						}
					}
				}

				if (marginPointer !== null && isSourceLine) {
					let [margin] = marginPointer
					let isColumn =
						multiLabel !== null && margin.label === multiLabel
					let isLimit = column + 1 === multiLabelsWithMessage.length

					if (!isColumn && !isLimit) {
						if (hbar === null) {
							hbar = margin.label
						}
					}
				}

				let a: [string, LabelInfo] | null
				let b: [string, LabelInfo] | null

				if (corner !== null) {
					let [label, isStart] = corner
					a = [arrowBend(draw, isStart), label]
					b = [draw.hbar, label]
				} else if (vbar !== null && hbar !== null) {
					a = [config.crossGap ? draw.vbar : draw.xbar, vbar]
					b = [draw.hbar, hbar]
				} else if (marginPointer !== null && isSourceLine) {
					let [margin, isStart] = marginPointer
					let isColumn =
						multiLabel !== null && margin.label === multiLabel
					let isLimit = column === multiLabelsWithMessage.length

					let character: string
					if (isLimit) {
						character = config.multilineArrows
							? draw.rarrow
							: draw.hbar
					} else if (isColumn) {
						character = isStart ? draw.ltop : draw.lcross
					} else {
						character = draw.hbar
					}

					a = [character, margin.label]
					b = [isLimit ? " " : draw.hbar, margin.label]
				} else if (hbar !== null) {
					a = [draw.hbar, hbar]
					b = [draw.hbar, hbar]
				} else if (vbar !== null) {
					a = [vbarCharacter(draw, isEllipsis), vbar]
					b = null
				} else {
					a = null
					b = null
				}

				const arrowCharacter = (
					option: [string, LabelInfo] | null,
				): string =>
					option === null
						? " "
						: paint(option[0], labelColor(option[1]))

				w.write(arrowCharacter(a))
				if (!config.compact) {
					w.write(arrowCharacter(b))
				}
			}
		}

		let isEllipsis = false

		for (
			let index = group.displayRange.start;
			index < group.displayRange.end;
			index++
		) {
			let line = source.line(index)
			if (line === null) {
				continue
			}

			// The (optional) label whose arrows are drawn in the margin
			// (horizontal), instead of normally (vertical).
			let marginCandidates: Array<LineLabel> = []
			for (let [i, label] of multiLabelsWithMessage.entries()) {
				let isStart = rangeContains(line.span, label.charSpan.start)
				let isEnd = rangeContains(line.span, lastOffset(label))

				if (isStart) {
					marginCandidates.push({
						column: label.charSpan.start - line.offset,
						label,
						multi: i,
						// Multi-line spans don't have their messages drawn at the start
						drawMessage: false,
					})
				} else if (isEnd) {
					marginCandidates.push({
						column: lastOffset(label) - line.offset,
						label,
						multi: i,
						// Multi-line spans have their messages drawn at the end
						drawMessage: true,
					})
				}
			}
			let marginLabel = minByKey(marginCandidates, (lineLabel) => [
				lineLabel.column,
				inverted(lineLabel.label.charSpan.start),
			])

			const isMarginLabel = (label: LabelInfo): boolean =>
				marginLabel !== null && marginLabel.label === label

			// Generate a list of labels for this line, along with their label
			// columns
			let lineLabels: Array<LineLabel> = []
			for (let [i, label] of multiLabelsWithMessage.entries()) {
				let isStart = rangeContains(line.span, label.charSpan.start)
				let isEnd = rangeContains(line.span, lastOffset(label))

				if (isStart && !isMarginLabel(label)) {
					lineLabels.push({
						column: label.charSpan.start - line.offset,
						label,
						multi: i,
						drawMessage: false,
					})
				} else if (isEnd) {
					lineLabels.push({
						column: lastOffset(label) - line.offset,
						label,
						multi: i,
						drawMessage: true,
					})
				}
			}
			for (let label of group.labels) {
				if (
					label.kind === "inline" &&
					label.charSpan.start >= line.span.start &&
					label.charSpan.end <= line.span.end
				) {
					let attachColumn: number
					switch (config.labelAttach) {
						case "start":
							attachColumn = label.charSpan.start
							break
						case "middle":
							attachColumn = Math.floor(
								(label.charSpan.start + label.charSpan.end) / 2,
							)
							break
						case "end":
							attachColumn = lastOffset(label)
							break
					}

					lineLabels.push({
						column:
							Math.max(attachColumn, label.charSpan.start) -
							line.offset,
						label,
						multi: null,
						drawMessage: true,
					})
				}
			}

			// Skip this line if we don't have labels for it...
			if (
				lineLabels.length === 0 &&
				marginLabel === null &&
				// ...and it does not intersect the display area of any labels
				group.labels.every(
					(label) =>
						Math.min(
							Math.abs(label.startLine - index),
							Math.abs(label.endLine - index),
						) > config.contextLines,
				)
			) {
				let withinLabel = multiLabels.some((label) =>
					rangeContains(label.charSpan, line.span.start),
				)

				if (!isEllipsis && withinLabel) {
					let shouldShow = multiLabels
						.filter((label) =>
							rangeContains(label.charSpan, line.span.start),
						)
						// Only one label on the line needs to require this line to be
						// shown
						.some((label) =>
							label.label.showLines === "all"
								? true
								: label.endLine - label.startLine <
									label.label.showLines,
						)

					if (!shouldShow) {
						isEllipsis = true
					}
				} else {
					if (!config.compact && !isEllipsis) {
						writeMargin(index, false, isEllipsis)
						w.writeLine()
					}
					isEllipsis = true
					continue
				}
			} else {
				isEllipsis = false
			}

			// Sort the labels by their columns
			stableSortByKey(lineLabels, (lineLabel) => [
				lineLabel.label.label.order,
				// `drawMessage = true` means that this is the end of the label
				config.minimiseCrossings && lineLabel.multi !== null
					? lineLabel.drawMessage
						? inverted(lineLabel.multi)
						: lineLabel.multi
					: -1,
				config.minimiseCrossings !== lineLabel.drawMessage
					? lineLabel.column
					: inverted(lineLabel.column),
				inverted(lineLabel.label.charSpan.start),
			])

			// Determine label bounds so we know where to put error messages
			let arrowEndSpace = config.compact ? 1 : 2
			let arrowLength =
				lineLabels.reduce(
					(length, lineLabel) =>
						lineLabel.multi !== null
							? line.charLength
							: Math.max(
									length,
									Math.max(
										0,
										lineLabel.label.charSpan.end -
											line.offset,
									),
								),
					0,
				) + arrowEndSpace

			// Should we draw a vertical bar as part of a label arrow on this line?
			const getVbar = (column: number, row: number): LineLabel | null => {
				for (let [j, lineLabel] of lineLabels.entries()) {
					// Only labels with messages get an arrow
					if (
						lineLabel.label.label.message === null ||
						isMarginLabel(lineLabel.label)
					) {
						continue
					}

					if (lineLabel.column === column && row <= j) {
						return lineLabel
					}
				}

				return null
			}

			const getHighlight = (column: number): LabelInfo | null => {
				let candidates: Array<LabelInfo> = []
				if (marginLabel !== null) {
					candidates.push(marginLabel.label)
				}
				candidates.push(...multiLabels)
				candidates.push(
					...lineLabels.map((lineLabel) => lineLabel.label),
				)

				let matching = candidates.filter((label) =>
					rangeContains(label.charSpan, line.offset + column),
				)

				// Prioritise displaying smaller spans
				return minByKey(matching, (label) => [
					-label.label.priority,
					rangeLength(label.charSpan),
				])
			}

			const getUnderline = (column: number): LineLabel | null => {
				let matching = lineLabels.filter(
					(lineLabel) =>
						config.underlines &&
						// Underlines only occur for inline spans (highlighting can
						// occur for all spans)
						lineLabel.multi === null &&
						rangeContains(
							lineLabel.label.charSpan,
							line.offset + column,
						),
				)

				// Prioritise displaying smaller spans
				return minByKey(matching, (lineLabel) => [
					-lineLabel.label.label.priority,
					rangeLength(lineLabel.label.charSpan),
				])
			}

			// Margin
			writeMarginAndArrows(
				index,
				true,
				isEllipsis,
				null,
				lineLabels,
				marginLabel,
			)

			// Line
			if (!isEllipsis) {
				let characters = [...source.getLineText(line).trimEnd()]

				for (let [column, character] of characters.entries()) {
					let highlight = getHighlight(column)
					let color =
						highlight !== null
							? labelColor(highlight)
							: config.unimportantColor()

					let [displayCharacter, width] = config.characterWidthOf(
						character,
						column,
					)

					if (/\s/u.test(displayCharacter)) {
						for (let i = 0; i < width; i++) {
							w.write(paint(displayCharacter, color))
						}
					} else {
						w.write(paint(displayCharacter, color))
					}
				}
			}
			w.writeLine()

			// Arrows
			for (let row = 0; row < lineLabels.length; row++) {
				let lineLabel = lineLabels[row]
				let message = lineLabel.label.label.message

				if (row === 0 || (message !== null && !config.compact)) {
					// Margin alternate
					writeMarginAndArrows(
						index,
						false,
						isEllipsis,
						[row, false],
						lineLabels,
						marginLabel,
					)

					// Lines alternate
					let characters = [...source.getLineText(line).trimEnd()]

					for (let column = 0; column < arrowLength; column++) {
						let width =
							column < characters.length
								? config.characterWidthOf(
										characters[column],
										column,
									)[1]
								: 1

						let vbarLabel = getVbar(column, row)
						let underlineLabel =
							row === 0 ? getUnderline(column) : null

						let head: string
						let tail: string

						if (vbarLabel !== null) {
							let headCharacter: string
							let tailCharacter: string

							if (underlineLabel !== null) {
								if (
									rangeLength(vbarLabel.label.charSpan) <= 1
								) {
									headCharacter = draw.underbarSingle
									tailCharacter = draw.underline
								} else if (
									line.offset + column ===
									vbarLabel.label.charSpan.start
								) {
									headCharacter = draw.lunderbar
									tailCharacter = draw.munderbar
								} else if (
									line.offset + column ===
									lastOffset(vbarLabel.label)
								) {
									headCharacter = draw.runderbar
									tailCharacter = draw.munderbar
								} else {
									headCharacter = draw.munderbar
									tailCharacter = draw.underline
								}
							} else if (
								vbarLabel.multi !== null &&
								row === 0 &&
								config.multilineArrows
							) {
								headCharacter = draw.uarrow
								tailCharacter = " "
							} else {
								headCharacter = draw.vbar
								tailCharacter = " "
							}

							head = paint(
								headCharacter,
								labelColor(vbarLabel.label),
							)
							tail = paint(
								tailCharacter,
								labelColor(vbarLabel.label),
							)
						} else if (underlineLabel !== null) {
							head = paint(
								draw.underline,
								labelColor(underlineLabel.label),
							)
							tail = head
						} else {
							head = " "
							tail = " "
						}

						for (let i = 0; i < width; i++) {
							w.write(i === 0 ? head : tail)
						}
					}
					w.writeLine()
				}

				// No message to draw thus no arrow to draw
				if (message === null) {
					continue
				}

				// Margin
				writeMarginAndArrows(
					index,
					false,
					isEllipsis,
					[row, true],
					lineLabels,
					marginLabel,
				)

				// Lines
				let characters = [...source.getLineText(line).trimEnd()]

				for (let column = 0; column < arrowLength; column++) {
					let width =
						column < characters.length
							? config.characterWidthOf(
									characters[column],
									column,
								)[1]
							: 1

					let isHbar =
						(column > lineLabel.column !==
							(lineLabel.multi !== null) ||
							(message !== null &&
								lineLabel.drawMessage &&
								column > lineLabel.column)) &&
						message !== null

					let head: string
					let tail: string

					if (
						column === lineLabel.column &&
						message !== null &&
						!isMarginLabel(lineLabel.label)
					) {
						head = paint(
							lineLabel.multi !== null
								? lineLabel.drawMessage
									? draw.mbot
									: draw.rbot
								: draw.lbot,
							labelColor(lineLabel.label),
						)
						tail = paint(draw.hbar, labelColor(lineLabel.label))
					} else {
						let vbarLabel = getVbar(column, row)

						if (
							vbarLabel !== null &&
							(column !== lineLabel.column || message !== null)
						) {
							if (!config.crossGap && isHbar) {
								head = paint(
									draw.xbar,
									labelColor(vbarLabel.label),
								)
								tail = paint(" ", labelColor(lineLabel.label))
							} else {
								head = paint(
									draw.vbar,
									labelColor(vbarLabel.label),
								)
								tail = paint(" ", labelColor(lineLabel.label))
							}
						} else if (isHbar) {
							head = paint(draw.hbar, labelColor(lineLabel.label))
							tail = head
						} else {
							head = " "
							tail = " "
						}
					}

					if (width > 0) {
						w.write(head)
					}
					for (let i = 1; i < width; i++) {
						w.write(tail)
					}
				}

				if (lineLabel.drawMessage) {
					w.write(` ${message}`)
				}
				w.writeLine()
			}
		}
	}

	// Help
	for (let [i, help] of report.helps.entries()) {
		if (!config.compact && i === 0) {
			writeMargin(0, false, false)
			w.writeLine()
		}

		let helpPrefix =
			report.helps.length > 1 && config.enumerateHelps
				? `Help ${i + 1}`
				: "Help"
		let lines = help.split("\n")

		writeMargin(0, false, false)
		w.writeLine(`${paint(helpPrefix, config.noteColor())}: ${lines[0]}`)

		for (let line of lines.slice(1)) {
			writeMargin(0, false, false)
			w.writeLine(`${" ".repeat(helpPrefix.length + 2)}${line}`)
		}
	}

	// Notes
	for (let [i, note] of report.notes.entries()) {
		if (!config.compact && i === 0) {
			writeMargin(0, false, false)
			w.writeLine()
		}

		let notePrefix =
			report.notes.length > 1 && config.enumerateNotes
				? `Note ${i + 1}`
				: "Note"
		let lines = note.split("\n")

		writeMargin(0, false, false)
		w.writeLine(`${paint(notePrefix, config.noteColor())}: ${lines[0]}`)

		for (let line of lines.slice(1)) {
			writeMargin(0, false, false)
			w.writeLine(`${" ".repeat(notePrefix.length + 2)}${line}`)
		}
	}

	// Tail of report. Not to be emitted in compact mode, or if nothing has had
	// the margin printed.
	if (!(config.compact || groups.length === 0)) {
		w.writeLine(
			paint(
				`${draw.hbar.repeat(lineNumberWidth + 2)}${draw.rbot}`,
				config.marginColor(),
			),
		)
	}

	let output = w.toString()
	return config.stripAnsi ? stripAnsi(output) : output
}
