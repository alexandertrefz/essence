import type { Color } from "./color"
import { Config } from "./config"
import type { Label } from "./label"
import { type Cache, Source, singleSource } from "./source"
import type { Span } from "./span"
import { writeReport } from "./write"

// The kind of a report: one of the built-in kinds, or a custom name with a
// display color.
export type ReportKind =
	| "error"
	| "warning"
	| "advice"
	| { name: string; color: Color }

export function reportKindName(kind: ReportKind): string {
	switch (kind) {
		case "error":
			return "Error"
		case "warning":
			return "Warning"
		case "advice":
			return "Advice"
		default:
			return kind.name
	}
}

export function reportKindColor(
	kind: ReportKind,
	config: Config,
): Color | null {
	switch (kind) {
		case "error":
			return config.errorColor()
		case "warning":
			return config.warningColor()
		case "advice":
			return config.adviceColor()
		default:
			return config.filterColor(kind.color)
	}
}

export interface ReportOptions<Id = unknown> {
	kind: ReportKind
	// The primary location at which the problem should be reported.
	span: Span<Id>
	// A stable identifier for this kind of report, shown before the kind name
	// as `[code] Error: ...`.
	code?: string
	message?: string
	labels?: Array<Label<Id>>
	notes?: Array<string>
	helps?: Array<string>
	config?: Config
}

// A diagnostic that is ready to be rendered.
export class Report<Id = unknown> {
	readonly kind: ReportKind
	readonly span: Span<Id>
	readonly code: string | null
	readonly message: string | null
	readonly labels: Array<Label<Id>>
	readonly notes: Array<string>
	readonly helps: Array<string>
	readonly config: Config

	constructor(options: ReportOptions<Id>) {
		this.kind = options.kind
		this.span = options.span
		this.code = options.code ?? null
		this.message = options.message ?? null
		this.labels = options.labels ?? []
		this.notes = options.notes ?? []
		this.helps = options.helps ?? []
		this.config = options.config ?? new Config()
	}

	// Renders this report to a string. Accepts a `Cache` for reports spanning
	// multiple sources, or a single `Source`/string for reports that only
	// concern one.
	render(source: Cache<Id> | Source | string): string {
		let cache: Cache<Id>

		if (typeof source === "string") {
			cache = singleSource(new Source(source)) as Cache<Id>
		} else if (source instanceof Source) {
			cache = singleSource(source) as Cache<Id>
		} else {
			cache = source
		}

		return writeReport(this, cache)
	}

	// Renders this report to stdout.
	print(source: Cache<Id> | Source | string): void {
		console.log(this.render(source).replace(/\n$/, ""))
	}

	// Renders this report to stderr.
	eprint(source: Cache<Id> | Source | string): void {
		console.error(this.render(source).replace(/\n$/, ""))
	}
}
