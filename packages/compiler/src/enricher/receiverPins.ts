import type { common, parser } from "@essence-lang/interfaces"

import {
	applyGenericBindings,
	borrowedGenericName,
	type GenericBindings,
	typeArgumentBindings,
} from "../helpers/types"

// A Method as a receiver calls it. Each Type Parameter of its Namespace that
// only the receiver's Type Arguments decide is pinned to its Type Argument. See
// "Receiver Type Arguments" in DEVELOPMENT.md.
export function pinnedForReceiver(
	namespace: common.NamespaceType,
	node: parser.MethodInvocationNode,
	receiver: common.Type,
): common.MethodType {
	let method = namespace.methods[node.member.content]
	let pins = receiverPins(namespace, receiver)

	if (method === undefined || pins.size === 0) {
		return method
	}

	let borrowed: GenericBindings = new Map(
		[...pins.keys()].map((name) => [
			name,
			{ type: "GenericUse", name: borrowedGenericName(name) },
		]),
	)
	let renamed = applyGenericBindings(method, borrowed) as common.MethodType
	let pinned = (generic: common.GenericDeclaration) => {
		let pin = pins.get(generic.name)

		return pin === undefined
			? {
					...generic,
					defaultType:
						generic.defaultType === null
							? null
							: applyGenericBindings(
									generic.defaultType,
									borrowed,
								),
				}
			: {
					...generic,
					name: borrowedGenericName(generic.name),
					infer: false,
					defaultType: pin,
				}
	}

	if (renamed.type === "OverloadedMethod") {
		return {
			...renamed,
			overloads: renamed.overloads.map((overload) => ({
				...overload,
				generics: overload.generics.map(pinned),
			})),
		}
	}

	return renamed.type === "SimpleMethod"
		? { ...renamed, generics: renamed.generics.map(pinned) }
		: renamed
}

// A Union target is asked whole, then by its members, as the lookup asks.
// Only a Case carries Type Arguments, so any other receiver pins nothing.
function receiverPins(
	namespace: common.NamespaceType,
	receiver: common.Type,
): GenericBindings {
	let target = namespace.targetType
	let members = target?.type === "UnionType" ? target.types : []
	let carriesCases =
		receiver.type === "Case" ||
		(receiver.type === "UnionType" &&
			receiver.types.some((member) => member.type === "Case"))

	if (namespace.generics.length === 0 || !carriesCases) {
		return new Map()
	}

	for (let targetType of [target, ...members]) {
		let pins = typeArgumentBindings(
			{ targetType, generics: namespace.generics },
			receiver,
		)

		if (pins !== null) {
			return pins
		}
	}

	return new Map()
}
