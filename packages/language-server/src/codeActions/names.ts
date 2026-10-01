import type { Scope } from "../rename"

// The name an extraction gives what it lifted out, numbered when taken. The
// whole Scope chain is checked, since shadowing an outer name would silently
// rebind its later reads.
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
