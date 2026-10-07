import type { common, enricher } from "@essence-lang/interfaces"

import {
	providedBodyFulfils,
	providedMethodProtocol,
} from "../helpers/conformance"
import { protocolGrants, protocolOf } from "./resolvers"

// Whose body answers a name `solving` requires, of everything the conformer
// conforms to. Where `solving` has a body of the name, only a Protocol
// extending the body's Protocol can replace it. Of the bodies that fulfil the
// requirement, the more derived Protocol's wins, then the first the clauses
// reach. See "The body a witness takes" in DEVELOPMENT.md.
export function conformanceProvidersIn(
	identities: Iterable<string>,
	solving: common.ProtocolType,
	// The conformer's declared target, never a narrower value, so every
	// call runs the body the declaration chose.
	target: common.Type,
	scope: enricher.Scope,
): (methodName: string) => string | null {
	let reached = [...identities].map((identity) => protocolOf(identity, scope))
	let fulfils = (provider: string, methodName: string): boolean => {
		let requirement = solving.methods[methodName]
		let body = protocolOf(provider, scope).methods[methodName]

		return (
			(requirement?.type === "SimpleMethod" && requirement === body) ||
			providedBodyFulfils(methodName, requirement, body, target)
		)
	}

	return (methodName) => {
		let seen = providedMethodProtocol(solving, methodName)
		let winner: string | null = null

		for (let protocol of reached) {
			let candidate = providedMethodProtocol(protocol, methodName)

			if (
				candidate !== null &&
				candidate !== winner &&
				(seen === null || protocolGrants(candidate, seen, scope)) &&
				(winner === null || protocolGrants(candidate, winner, scope)) &&
				fulfils(candidate, methodName)
			) {
				winner = candidate
			}
		}

		return winner
	}
}
