import { isDeepStrictEqual } from "node:util"

import type { common } from "../interfaces/index"

// NOTE: The active Diagnostic list is module state so that the Enricher and
// Validator do not have to thread a collector through every function. Both
// stages run synchronously, so there is never more than one collection active
// per nesting level.
let activeDiagnostics: Array<common.Diagnostic> = []

// NOTE: A few Nodes are still typed more than once within one enrichment — a
// Function definition's signature is resolved both for its own Type and while
// its typed body is built. Deduplication keeps those repeated resolutions from
// reporting the same Diagnostic twice.
function isDuplicate(diagnostic: common.Diagnostic): boolean {
	return activeDiagnostics.some(
		(existingDiagnostic) =>
			existingDiagnostic.severity === diagnostic.severity &&
			existingDiagnostic.code === diagnostic.code &&
			existingDiagnostic.message === diagnostic.message &&
			isDeepStrictEqual(existingDiagnostic.position, diagnostic.position),
	)
}

// NOTE: Label constructors rather than object literals, so that the common
// case — a primary Label on the Diagnostic's own Position — stays one short
// line at the ~100 report sites and the `kind` is never left to a default.
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

// NOTE: `code` and `labels` are required; `notes` and `helps` default to
// empty, because writing `notes: []` at a site that has nothing to add is
// noise while omitting a Label never is — see the invariant on
// `common.Diagnostic`.
type DiagnosticDetails = {
	code: common.DiagnosticCode
	notes?: Array<string>
	helps?: Array<string>
	tags?: Array<common.DiagnosticTag>
}

// NOTE: The overloads are what carry the invariant down to the call sites: a
// Diagnostic with a Position must name at least one Label, a placeless one
// must name none. A site holding a `Position | null` matches neither and has
// to branch — which is the point, because the two cases genuinely produce
// different reports.
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

// NOTE: For the Diagnostics that are about the Compiler run rather than about
// a Program — a file that could not be read, a bundle that failed. They have
// no source to point into, which is exactly the placeless half of the
// `Diagnostic` union.
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

// NOTE: Collections nest — Diagnostics reported inside `work` are captured
// into a fresh list and do not leak into the surrounding collection. This
// allows speculative resolution whose Diagnostics are only committed (via
// `report`) when the speculation is kept.
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
