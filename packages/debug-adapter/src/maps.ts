import { readFileSync } from "node:fs"
import * as path from "node:path"

import type { RawSourceMap } from "source-map"
import { SourceMapConsumer } from "source-map"

// The bundle's map, asked where a source line landed in the bundle and where
// a bundle position came from. `.es` lines are 1-based and columns 0-based, as
// the source-map library has them; generated positions are CDP's, 0-based.

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

	// Null when the bundle has no map beside it. Such a session still runs,
	// but binds no breakpoints and maps no frames.
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

	// The map's sources are absolute paths, and a client may spell a file
	// differently, so both are normalised before comparing.
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
		// `LEAST_UPPER_BOUND` slides a breakpoint on a blank or comment line
		// to the next statement; `GREATEST_LOWER_BOUND` catches a line after
		// the last one.
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

	// Every mapping of the bundle, with 0-based generated lines, from which
	// stepping derives its blackboxed ranges.
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
