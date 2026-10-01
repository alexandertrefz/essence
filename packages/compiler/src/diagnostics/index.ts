import { isDeepStrictEqual } from "node:util"

import type { common } from "@essence-lang/interfaces"

// The open collection, kept in module state so that no stage threads a
// collector through its functions. Stages run synchronously, so collections
// only ever nest.
let activeDiagnostics: Array<common.Diagnostic> = []

// A Node typed more than once in one enrichment reports its problems each
// time, so `report` keeps only the first of equal Diagnostics.
function isDuplicate(diagnostic: common.Diagnostic): boolean {
	return activeDiagnostics.some(
		(existingDiagnostic) =>
			existingDiagnostic.severity === diagnostic.severity &&
			existingDiagnostic.code === diagnostic.code &&
			existingDiagnostic.message === diagnostic.message &&
			isDeepStrictEqual(existingDiagnostic.position, diagnostic.position),
	)
}

export function primary(
	position: common.Position,
	message: string,
): common.DiagnosticLabel {
	return { position, message, kind: "primary" }
}

export function secondary(
	position: common.Position,
	message: string,
): common.DiagnosticLabel {
	return { position, message, kind: "secondary" }
}

export function report(diagnostic: common.Diagnostic): void {
	if (!isDuplicate(diagnostic)) {
		activeDiagnostics.push(diagnostic)
	}
}

// `notes` and `helps` default to empty, since a site with nothing to add
// would only write `[]` there.
type DiagnosticDetails = {
	code: common.DiagnosticCode
	notes?: Array<string>
	helps?: Array<string>
	tags?: Array<common.DiagnosticTag>
	data?: common.DiagnosticData
}

// The overloads require a Diagnostic with a Position to name at least one
// Label, and a placeless one to name none. A site holding a
// `Position | null` matches neither, and branches.
type LocatedDetails = DiagnosticDetails & {
	labels: [common.DiagnosticLabel, ...Array<common.DiagnosticLabel>]
}

type PlacelessDetails = DiagnosticDetails & { labels: [] }

function buildDiagnostic(
	severity: common.DiagnosticSeverity,
	message: string,
	position: common.Position | null,
	details: LocatedDetails | PlacelessDetails,
): common.Diagnostic {
	let base = { severity, message, notes: [], helps: [], ...details }

	return position === null
		? { ...base, position, labels: [] }
		: {
				...base,
				position,
				labels: details.labels as LocatedDetails["labels"],
			}
}

export function reportError(
	message: string,
	position: common.Position,
	details: LocatedDetails,
): void
export function reportError(
	message: string,
	position: null,
	details: PlacelessDetails,
): void
export function reportError(
	message: string,
	position: common.Position | null,
	details: LocatedDetails | PlacelessDetails,
): void {
	report(buildDiagnostic("error", message, position, details))
}

export function reportWarning(
	message: string,
	position: common.Position,
	details: LocatedDetails,
): void
export function reportWarning(
	message: string,
	position: null,
	details: PlacelessDetails,
): void
export function reportWarning(
	message: string,
	position: common.Position | null,
	details: LocatedDetails | PlacelessDetails,
): void {
	report(buildDiagnostic("warning", message, position, details))
}

// A remark about what the compiler did, which a reader may ignore and still
// have a correct Program. It has a Warning's shape, so it can be looked up
// and placed.
export function reportInformation(
	message: string,
	position: common.Position,
	details: LocatedDetails,
): void
export function reportInformation(
	message: string,
	position: null,
	details: PlacelessDetails,
): void
export function reportInformation(
	message: string,
	position: common.Position | null,
	details: LocatedDetails | PlacelessDetails,
): void {
	report(buildDiagnostic("information", message, position, details))
}

// A Diagnostic about the run rather than a Program, such as a file that could
// not be read. It has no source to point into.
export function placelessDiagnostic(
	severity: common.DiagnosticSeverity,
	message: string,
	code: common.DiagnosticCode,
): common.Diagnostic {
	return {
		severity,
		message,
		position: null,
		labels: [],
		notes: [],
		helps: [],
		code,
	}
}

export function containsErrors(diagnostics: Array<common.Diagnostic>): boolean {
	return diagnostics.some((diagnostic) => diagnostic.severity === "error")
}

// Orders a report by line rather than by the stage that found each
// Diagnostic. The sort is stable, so on a shared Position the earlier stage,
// which explains the later, stays first. A placeless Diagnostic has no line
// and goes first.
export function inSourceOrder(
	diagnostics: Array<common.Diagnostic>,
): Array<common.Diagnostic> {
	return diagnostics
		.map((diagnostic, index) => ({ diagnostic, index }))
		.sort((left, right) => {
			let here = left.diagnostic.position
			let there = right.diagnostic.position

			if (here === null || there === null) {
				return here === there
					? left.index - right.index
					: here === null
						? -1
						: 1
			}

			return (
				here.start.line - there.start.line ||
				here.start.column - there.start.column ||
				left.index - right.index
			)
		})
		.map(({ diagnostic }) => diagnostic)
}

// Whether a Diagnostic of this code, and of `message` when given, already
// stands on this line. The resolvers ask before refusing the next piece of a
// foreign String, or guessing a bare Case on a foreign line.
export function reportedOnLine(
	code: common.DiagnosticCode,
	line: number,
	message?: string,
): boolean {
	return activeDiagnostics.some(
		(diagnostic) =>
			diagnostic.code === code &&
			(message === undefined || diagnostic.message === message) &&
			diagnostic.position !== null &&
			diagnostic.position.start.line === line,
	)
}

// A savepoint in the open collection, for speculative work that is mostly
// abandoned. It is cheaper than a fresh collection per attempt. Rewinding
// drops what the rejected reading reported since the mark.
export function markDiagnostics(): number {
	return activeDiagnostics.length
}

export function rewindDiagnostics(mark: number): void {
	activeDiagnostics.length = mark
}

// Collects what `work` reports into a fresh list, which never leaks into the
// surrounding collection. Speculative work hands on what it keeps with
// `report`.
export function collectDiagnostics<T>(work: () => T): {
	result: T
	diagnostics: Array<common.Diagnostic>
} {
	let previousDiagnostics = activeDiagnostics
	activeDiagnostics = []

	try {
		let result = work()

		return { result, diagnostics: activeDiagnostics }
	} finally {
		activeDiagnostics = previousDiagnostics
	}
}
