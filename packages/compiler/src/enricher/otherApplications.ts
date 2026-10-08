import type { common, enricher } from "@essence-lang/interfaces"

import { choiceCarried, describeType } from "../helpers/describe"
import {
	applyGenericBindings,
	bindNamespaceTarget,
	coversApartFromTypeArguments,
	flattenUnionMembers,
	type GenericBindings,
	genericNamesMentioned,
	matchesType,
	typeContainsUnknown,
	typeMentionsGeneric,
} from "../helpers/types"
import { getAllNamespacesInScope, namespacesTargeting } from "./resolvers"
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

// The first phantom Type Argument of a receiver's Case that the target's Case
// of the same tag does not take, once the target is bound. Null where each
// one fits.
function phantomMismatch(
	namespace: common.NamespaceType,
	receiver: common.Type,
	scope: enricher.Scope,
): PhantomMismatch | null {
	let carriers = phantomCarriers(receiver, scope)
	let bound = carriers.length === 0 ? null : boundTarget(namespace, receiver)

	if (bound === null) {
		return null
	}

	for (let carrier of carriers) {
		let mismatches = casesOf(bound.target)
			.filter(
				(arm) =>
					arm.choice === carrier.choice && arm.name === carrier.name,
			)
			.map((arm) =>
				armMismatch(arm, carrier, bound.bindings, namespace, scope),
			)

		if (mismatches.length > 0 && !mismatches.includes(null)) {
			return mismatches[0]!
		}
	}

	return null
}

function armMismatch(
	arm: common.CaseType,
	carrier: common.CaseType,
	bindings: GenericBindings,
	namespace: common.NamespaceType,
	scope: enricher.Scope,
): PhantomMismatch | null {
	// A Type Parameter the target leaves unbound takes any Type Argument.
	let open = namespace.generics.filter(
		(generic) => !bindings.has(generic.name),
	)

	for (let [index, parameter] of phantomParameters(carrier, scope)) {
		let target = arm.typeArguments?.[index]
		let actual = carrier.typeArguments?.[index]

		if (
			target !== undefined &&
			actual !== undefined &&
			!typeContainsUnknown(actual) &&
			!open.some((generic) =>
				typeMentionsGeneric(target, generic.name),
			) &&
			!matchesType(target, actual)
		) {
			return { parameter, target, receiver: actual }
		}
	}

	return null
}

// The target bound from the receiver, whole or by the member of a Union
// target that covers it, as the lookup asks.
function boundTarget(
	namespace: common.NamespaceType,
	receiver: common.Type,
): { target: common.Type; bindings: GenericBindings } | null {
	let target = namespace.targetType
	let members = target?.type === "UnionType" ? target.types : []

	for (let targetType of [target, ...members]) {
		let bindings =
			targetType === null
				? null
				: bindNamespaceTarget(
						{ targetType, generics: namespace.generics },
						receiver,
					)

		if (targetType !== null && bindings !== null) {
			return {
				target: applyGenericBindings(targetType, bindings),
				bindings,
			}
		}
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

// Remembered per declaration, which every Case of the Choice reads.
const phantomParametersMemo = new WeakMap<
	common.Type,
	Array<[number, common.GenericName]>
>()

// The positions and names of the Type Parameters of a Case's Choice that no
// payload of any of its Cases names. Read off the Choice's declaration, here
// or in its own Module. Empty where none is found.
function phantomParameters(
	carrier: common.CaseType,
	scope: enricher.Scope,
): Array<[number, common.GenericName]> {
	let foreign = unboundForeignChoice(carrier, scope)
	let declared =
		foreign === null
			? (choiceBindingIn(carrier.choice, scope)?.type ?? null)
			: foreignChoiceDeclaration(foreign, scope)

	if (
		declared?.type !== "GenericAlias" ||
		declared.aliasedType.type !== "UnionType"
	) {
		return []
	}

	let remembered = phantomParametersMemo.get(declared)

	if (remembered === undefined) {
		let named = new Set(
			flattenUnionMembers(declared.aliasedType).flatMap((member) =>
				member.type === "Case"
					? Object.values(member.members).flatMap((payload) => [
							...genericNamesMentioned(payload),
						])
					: [],
			),
		)

		remembered = declared.generics.flatMap((generic, index) =>
			named.has(generic.name)
				? []
				: [[index, generic.name] as [number, common.GenericName]],
		)
		phantomParametersMemo.set(declared, remembered)
	}

	return remembered
}

// A Note for each Namespace in scope that declares the Method for another
// application of the receiver's Choice. Its target covers the receiver's
// payloads, and only the receiver's Type Arguments turn it away. See
// "Namespace targets" in packages/compiler/src/helpers/DEVELOPMENT.md.
export function otherApplicationNotes(
	methodName: string,
	receiver: common.Type,
	scope: enricher.Scope,
): Array<string> {
	let choice = choiceCarried(receiver)

	if (choice === null) {
		return []
	}

	let namespaces = getAllNamespacesInScope(scope, null)
	let targeting = namespacesTargeting(namespaces, receiver)

	return [...namespaces].flatMap(([name, namespace]) => {
		if (
			namespace.targetType === null ||
			!Object.hasOwn(namespace.methods, methodName)
		) {
			return []
		}

		let declares = `'${name}' declares '${methodName}' for ${describeType(namespace.targetType)}`
		let phantom = targeting.has(name)
			? phantomMismatch(namespace, receiver, scope)
			: null

		if (phantom !== null) {
			return [
				`${declares}, which takes ${describeType(phantom.target)} for '${phantom.parameter}' where this value has ${describeType(phantom.receiver)}, and no payload carries '${phantom.parameter}'.`,
			]
		}

		return !targeting.has(name) &&
			coversApartFromTypeArguments(namespace, receiver)
			? [
					`${declares}, another application of '${choiceNameIn(choice, scope)}'.`,
				]
			: []
	})
}
