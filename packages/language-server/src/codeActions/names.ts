import type { Scope } from "../rename"

// NOTE: The name an extraction gives what it lifted out, with a number after it
// where the Scope already has one. The whole chain is walked rather than the one
// Scope: a name that shadows one read further down the same body would rebind it
// silently, and an extraction that renames somebody's code by accident is worse
// than one that writes `total2`.
export function availableName(name: string, scope: Scope): string {
	if (!isTaken(name, scope)) {
		return name
	}

	for (let suffix = 2; ; suffix++) {
		if (!isTaken(`${name}${suffix}`, scope)) {
			return `${name}${suffix}`
		}
	}
}

function isTaken(name: string, scope: Scope): boolean {
	for (
		let candidate: Scope | null = scope;
		candidate !== null;
		candidate = candidate.parent
	) {
		if (candidate.values.has(name)) {
			return true
		}
	}

	return false
}
