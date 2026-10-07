import type { common, enricher } from "@essence-lang/interfaces"

import {
	describeParameter,
	describeType,
	withArticle,
} from "../helpers/describe"
import {
	applyGenericBindings,
	flattenUnionMembers,
	type GenericBindings,
	matchesType,
} from "../helpers/types"
import { printType } from "../printType"
import { describeProtocol, protocolOf } from "./resolvers"
import { annotateAtChoiceHelp } from "./spelling"

// A Method a Namespace writes may fit its requirement at the Namespace's
// target but not at a narrower binding: `next() -> Colour` fits no `Self` of
// `Colour#Red`. The report names the first Parameter the requirement accepts
// more widely, or else the answer. At the target the conformance itself is at
// fault, and nothing is added.
export function narrowedMethodReport(
	protocol: common.ProtocolType,
	methodName: string,
	namespace: { name: string; type: common.NamespaceType },
	binding: common.Type,
	scope: enricher.Scope,
): { notes: Array<string>; helps: Array<string> } {
	let requirement = protocol.methods[methodName]
	let written = namespace.type.methods[methodName]
	let target = namespace.type.targetType
	let at = describeType(binding)

	if (
		target === null ||
		!matchesType(target, binding) ||
		matchesType(binding, target)
	) {
		return { notes: [], helps: [] }
	}

	let asked = describeProtocol(protocol.identity, scope)
	// A bare Case binds the Case, so its value is annotated at the Choice. A
	// Namespace covering more than the Choice answers no `Self` of it either.
	let helps = [
		binding.type !== "Case"
			? `Declare a Namespace for ${at} that conforms to '${asked}'.`
			: annotateAtChoiceHelp(
					binding,
					scope,
					", since",
					false,
					targetsChoiceOf(target, binding) ? null : asked,
				),
	]

	if (
		requirement?.type !== "SimpleMethod" ||
		written?.type !== "SimpleMethod"
	) {
		return { notes: [], helps }
	}

	let required = applyGenericBindings(
		requirement,
		new Map([["Self", binding]]),
	) as common.SimpleMethodType
	let owner = `'${methodName}' in '${namespace.name}'`

	for (let index = 1; index < required.parameterTypes.length; index++) {
		let accepted = required.parameterTypes[index]!
		let taken = written.parameterTypes[index]

		if (taken !== undefined && !matchesType(taken.type, accepted.type)) {
			return {
				notes: [
					`${owner} takes ${withArticle(describeType(taken.type))} as ${describeParameter(accepted, index - 1)}, where '${asked}' accepts any ${describeType(accepted.type)} at ${at}.`,
				],
				helps,
			}
		}
	}

	return {
		notes: [
			`${owner} answers ${withArticle(describeType(written.returnType))} at ${at}, where '${asked}' answers ${withArticle(describeType(required.returnType))}.`,
		],
		helps,
	}
}

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

// Whether a Namespace's target is the Choice a Case belongs to and nothing
// besides.
function targetsChoiceOf(
	target: common.Type,
	caseType: common.CaseType,
): boolean {
	let arms =
		target.type === "UnionType" ? flattenUnionMembers(target) : [target]

	return arms.every(
		(arm) => arm.type === "Case" && arm.choice === caseType.choice,
	)
}
