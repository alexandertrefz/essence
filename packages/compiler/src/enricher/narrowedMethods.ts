import type { common, enricher } from "@essence-lang/interfaces"

import {
	describeParameter,
	describeType,
	withArticle,
} from "../helpers/describe"
import {
	applyGenericBindings,
	type GenericBindings,
	matchesType,
} from "../helpers/types"
import { printType } from "../printType"
import { describeProtocol, protocolOf } from "./resolvers"
import { annotateAtChoiceHelp } from "./spelling"

// What a report says of a body that fulfils its requirement at the target
// but not at the narrower binding. It names the first Parameter taken
// narrower than the requirement accepts, or else the answer.
export function narrowedBodyReport(
	protocol: common.ProtocolType,
	methodName: string,
	provider: string,
	binding: common.Type,
	scope: enricher.Scope,
	// The Protocol the call asks for, where a body of another reads this.
	askedFor: string = protocol.identity,
): { notes: Array<string>; helps: Array<string> } {
	let requirement = protocol.methods[methodName] as common.SimpleMethodType
	let body = protocolOf(provider, scope).methods[
		methodName
	] as common.SimpleMethodType
	let bindings: GenericBindings = new Map([["Self", binding]])
	let required = applyGenericBindings(
		requirement,
		bindings,
	) as common.SimpleMethodType
	let narrowed = applyGenericBindings(
		body,
		bindings,
	) as common.SimpleMethodType
	let theBody = `the body '${describeProtocol(provider, scope)}' provides`
	let asked = describeProtocol(protocol.identity, scope)
	let at = describeType(binding)
	let elsewhere =
		binding.type === "Case"
			? annotateAtChoiceHelp(binding, scope, ", since", true)
			: `or declare a Namespace for ${at} that conforms to '${describeProtocol(askedFor, scope)}'.`

	// The first Parameter is `Self`, the receiver, which both take.
	for (let index = 1; index < required.parameterTypes.length; index++) {
		let accepted = required.parameterTypes[index]!
		let taken = narrowed.parameterTypes[index]!

		if (!matchesType(taken.type, accepted.type)) {
			let parameter = describeParameter(accepted, index - 1)

			return {
				notes: [
					`'${methodName}' runs ${theBody}, whose ${parameter} is '${printType(body.parameterTypes[index]!.type)}': at ${at} it takes ${withArticle(describeType(taken.type))}, where '${asked}' accepts any ${describeType(accepted.type)}.`,
				],
				helps: [
					`Take '${printType(requirement.parameterTypes[index]!.type)}' as ${parameter} in ${theBody}, ${elsewhere}`,
				],
			}
		}
	}

	return {
		notes: [
			`'${methodName}' runs ${theBody}, which answers ${withArticle(describeType(narrowed.returnType))} at ${at}, where '${asked}' answers ${withArticle(describeType(required.returnType))}.`,
		],
		helps: [
			`Answer '${printType(requirement.returnType)}' from ${theBody}, ${elsewhere}`,
		],
	}
}
