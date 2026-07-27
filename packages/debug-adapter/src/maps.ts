import { readFileSync } from "node:fs"
import * as path from "node:path"

import type { RawSourceMap } from "source-map"
import { SourceMapConsumer } from "source-map"

// NOTE: The bundle's map, wrapped in the two questions a session asks of it:
// where a source line landed in the bundle (breakpoints) and where a bundle
// position came from (stacks, stops). Conventions are pinned HERE and nowhere
// else: `.es` lines are 1-based and columns 0-based — the source-map library's
// own — and generated positions are CDP's, 0-based on both axes.

export type GeneratedPosition = {
	line: number
	column: number
}

export type OriginalPosition = {
	source: string
	line: number
	column: number
}

export class BundleMap {
	private consumer: SourceMapConsumer
	readonly sources: Array<string>

	constructor(raw: RawSourceMap) {
		this.consumer = new SourceMapConsumer(raw)
		this.sources = [...raw.sources]
	}

	// NOTE: Null when the bundle carries no map beside it — a session without
	// one still runs; it just binds no breakpoints and maps no frames.
	static load(bundlePath: string): BundleMap | null {
		try {
			return new BundleMap(
				JSON.parse(
					readFileSync(`${bundlePath}.map`, "utf-8"),
				) as RawSourceMap,
			)
		} catch {
			return null
		}
	}

	// NOTE: The map's sources are the compiler's canonical absolute paths; a
	// client may spell the same file its own way, so the lookup normalises
	// before it compares.
	sourceFor(clientPath: string): string | null {
		let normalised = path.normalize(clientPath)

		return (
			this.sources.find(
				(source) => path.normalize(source) === normalised,
			) ?? null
		)
	}

	generatedPositionFor(
		source: string,
		line: number,
	): GeneratedPosition | null {
		// NOTE: A breakpoint on a blank or comment line should slide to the
		// next mapped statement, which is what LEAST_UPPER_BOUND answers; the
		// GREATEST_LOWER_BOUND retry catches a line after the last statement.
		for (let bias of [
			SourceMapConsumer.LEAST_UPPER_BOUND,
			SourceMapConsumer.GREATEST_LOWER_BOUND,
		]) {
			let position = this.consumer.generatedPositionFor({
				source,
				line,
				column: 0,
				bias,
			})

			if (position.line !== null) {
				return {
					line: position.line - 1,
					column: position.column ?? 0,
				}
			}
		}

		return null
	}

	originalPositionFor(position: GeneratedPosition): OriginalPosition | null {
		let original = this.consumer.originalPositionFor({
			line: position.line + 1,
			column: position.column,
		})

		if (original.source === null || original.line === null) {
			return null
		}

		return {
			source: original.source,
			line: original.line,
			column: original.column ?? 0,
		}
	}

	// NOTE: Every mapping of the bundle, generated side, 0-based — what the
	// stepping logic derives its blackboxed ranges from.
	eachMapping(
		visit: (mapping: {
			generatedLine: number
			generatedColumn: number
			source: string | null
			originalLine: number | null
		}) => void,
	): void {
		this.consumer.eachMapping((mapping) => {
			visit({
				generatedLine: mapping.generatedLine - 1,
				generatedColumn: mapping.generatedColumn,
				source: mapping.source,
				originalLine: mapping.originalLine,
			})
		})
	}
}
