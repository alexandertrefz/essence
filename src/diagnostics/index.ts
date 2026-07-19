import deepEqual from "deep-equal"

import type { common } from "../interfaces"

// NOTE: The active Diagnostic list is module state so that the Enricher and
// Validator do not have to thread a collector through every function. Both
// stages run synchronously, so there is never more than one collection active
// per nesting level.
let activeDiagnostics: Array<common.Diagnostic> = []

// NOTE: The Enricher resolves some Nodes more than once; deduplication keeps
// those repeated resolutions from reporting the same Diagnostic twice.
function isDuplicate(diagnostic: common.Diagnostic): boolean {
	return activeDiagnostics.some(
		(existingDiagnostic) =>
			existingDiagnostic.severity === diagnostic.severity &&
			existingDiagnostic.message === diagnostic.message &&
			deepEqual(existingDiagnostic.position, diagnostic.position),
	)
}

export function report(diagnostic: common.Diagnostic): void {
	if (!isDuplicate(diagnostic)) {
		activeDiagnostics.push(diagnostic)
	}
}

export function reportError(
	message: string,
	position: common.Position | null = null,
): void {
	report({ severity: "error", message, position })
}

export function reportWarning(
	message: string,
	position: common.Position | null = null,
): void {
	report({ severity: "warning", message, position })
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
