import type { common, enricher } from "@essence-lang/interfaces"

import { choiceCarried, describeType, withArticle } from "../helpers/describe"
import {
	bindNamespaceTarget,
	coversApartFromTypeArguments,
	flattenUnionMembers,
	type GenericBindings,
	phantomMismatchOf,
	phantomParametersOf,
	typeMentionsGeneric,
} from "../helpers/types"
import {
	describeProtocol,
	getAllNamespacesInScope,
	namespacesTargeting,
} from "./resolvers"
import {
	choiceBindingIn,
	choiceNameIn,
	foreignChoiceDeclaration,
	unboundForeignChoice,
} from "./spelling"

// The Namespaces whose target covers a receiver, less those a phantom Type
// Argument of it turns away. The memoised answer is shared, so a caller copies
// it before changing it. See "Phantom Type Arguments" in DEVELOPMENT.md.
export function namespacesCovering(
	named: Map<string, common.NamespaceType> | null,
	receiver: common.Type,
	scope: enricher.Scope,
): Map<string, common.NamespaceType> {
	let targeting = namespacesTargeting(
		named ?? getAllNamespacesInScope(scope, null),
		receiver,
	)

	if (phantomCarriers(receiver, scope).length === 0) {
		return targeting
	}

	let kept = [...targeting].filter(
		([, namespace]) => phantomMismatch(namespace, receiver, scope) === null,
	)

	return kept.length === targeting.size ? targeting : new Map(kept)
}

// The receiver's Cases whose Choice has a phantom Type Parameter.
function phantomCarriers(
	receiver: common.Type,
	scope: enricher.Scope,
): Array<common.CaseType> {
	return casesOf(receiver).filter(
		(carrier) => phantomParameters(carrier, scope).length > 0,
	)
}

type PhantomMismatch = {
	parameter: common.GenericName
	target: common.Type
	receiver: common.Type
}

// How many targets were bound to compare phantom Type Arguments. A spec holds
// a Choice without phantom Type Parameters to none, without a clock.
export const phantomTargetChecks = { count: 0 }

// The first phantom Type Argument of a receiver's Case that the target does
// not take, or null. A Union target is read whole or by the member covering
// the receiver, as the lookup reads it.
function phantomMismatch(
	namespace: common.NamespaceType,
	receiver: common.Type,
	scope: enricher.Scope,
): PhantomMismatch | null {
	if (phantomCarriers(receiver, scope).length === 0) {
		return null
	}

	phantomTargetChecks.count += 1

	let target = namespace.targetType
	let members = target?.type === "UnionType" ? target.types : []
	let positions = (carrier: common.CaseType) =>
		phantomParameters(carrier, scope).map(([index]) => index)

	for (let targetType of [target, ...members]) {
		let pattern =
			targetType === null
				? null
				: { targetType, generics: namespace.generics }

		if (
			pattern === null ||
			bindNamespaceTarget(pattern, receiver) === null
		) {
			continue
		}

		let mismatch = phantomMismatchOf(pattern, receiver, positions)
		let parameter =
			mismatch === null
				? undefined
				: phantomParameters(mismatch.carrier, scope).find(
						([index]) => index === mismatch.index,
					)?.[1]

		return mismatch === null || parameter === undefined
			? null
			: { parameter, target: mismatch.target, receiver: mismatch.actual }
	}

	return null
}

function casesOf(type: common.Type): Array<common.CaseType> {
	let members = type.type === "UnionType" ? flattenUnionMembers(type) : [type]

	return members.filter(
		(member): member is common.CaseType =>
			member.type === "Case" && member.typeArguments !== undefined,
	)
}

// Remembered per Case, whose declaration never changes.
const phantomParametersOfCase = new WeakMap<
	common.CaseType,
	Array<[number, common.GenericName]>
>()

// The positions and names of the Type Parameters of a Case's Choice that no
// payload of any of its Cases names. Read off the Choice's declaration, here
// or in its own Module. Empty where none is found.
function phantomParameters(
	carrier: common.CaseType,
	scope: enricher.Scope,
): Array<[number, common.GenericName]> {
	let known = phantomParametersOfCase.get(carrier)

	if (known !== undefined) {
		return known
	}

	let foreign = unboundForeignChoice(carrier, scope)
	let declared =
		foreign === null
			? (choiceBindingIn(carrier.choice, scope)?.type ?? null)
			: foreignChoiceDeclaration(foreign, scope)
	let remembered = declared === null ? null : phantomParametersOf(declared)

	if (remembered === null) {
		return []
	}

	phantomParametersOfCase.set(carrier, remembered)

	return remembered
}

// A Note for each Namespace in scope that declares the Method for another
// application of a receiver's Choice, the first receiver it turns away read.
// Its target covers the payloads, and only the Type Arguments turn it away.
// See "Namespace targets" in packages/compiler/src/helpers/DEVELOPMENT.md.
export function otherApplicationNotes(
	methodName: string,
	receivers: Array<common.Type>,
	scope: enricher.Scope,
): Array<string> {
	let namespaces = getAllNamespacesInScope(scope, null)
	let targeting = receivers.map((receiver) =>
		namespacesTargeting(namespaces, receiver),
	)

	return [...namespaces].flatMap(([name, namespace]) => {
		if (!Object.hasOwn(namespace.methods, methodName)) {
			return []
		}

		for (let [index, receiver] of receivers.entries()) {
			let notes = turnedAwayNotes(
				`'${name}' declares '${methodName}'`,
				namespace,
				receiver,
				targeting[index]!.has(name),
				scope,
			)

			if (notes.length > 0) {
				return notes
			}
		}

		return []
	})
}

// A conformance's target bound from a Type, as a `::` call reads it. Null
// where it does not cover the Type, a phantom Type Argument included.
export function conformingBindings(
	namespace: common.NamespaceType,
	type: common.Type,
	scope: enricher.Scope,
): GenericBindings | null {
	let bindings = bindNamespaceTarget(namespace, type)

	return bindings === null || phantomMismatch(namespace, type, scope) === null
		? bindings
		: null
}

// The Notes `otherApplicationNotes` gives, for each Namespace in scope that
// declares a Protocol for another application of the Type's Choice.
export function otherConformerNotes(
	protocolName: string,
	type: common.Type,
	scope: enricher.Scope,
): Array<string> {
	return [...getAllNamespacesInScope(scope, null)].flatMap(
		([name, namespace]) =>
			namespace.conformsTo?.includes(protocolName) === true
				? turnedAwayNotes(
						`'${name}' conforms to '${describeProtocol(protocolName, scope)}'`,
						namespace,
						type,
						bindNamespaceTarget(namespace, type) !== null,
						scope,
					)
				: [],
	)
}

// Why a Namespace whose target covers the receiver's payloads is turned away.
// `covers` says whether its target covers the receiver as the lookup reads it.
function turnedAwayNotes(
	lead: string,
	namespace: common.NamespaceType,
	receiver: common.Type,
	covers: boolean,
	scope: enricher.Scope,
): Array<string> {
	let choice = choiceCarried(receiver)

	if (choice === null || namespace.targetType === null) {
		return []
	}

	let declares = `${lead} for ${describeType(namespace.targetType)}`
	let phantom = covers ? phantomMismatch(namespace, receiver, scope) : null

	if (phantom !== null) {
		return [
			`${declares}, which takes ${describeType(phantom.target)} for '${phantom.parameter}' where this value has ${describeType(phantom.receiver)}, and no payload carries '${phantom.parameter}'.`,
		]
	}

	if (covers || !coversApartFromTypeArguments(namespace, receiver)) {
		return []
	}

	// A target with Type Parameters stands for many applications, none of
	// them the receiver's.
	let generic = namespace.generics.some((parameter) =>
		typeMentionsGeneric(namespace.targetType!, parameter.name),
	)

	return [
		generic
			? `${declares}, which ${withArticle(describeType(receiver))} is not.`
			: `${declares}, another application of '${choiceNameIn(choice, scope)}'.`,
	]
}
