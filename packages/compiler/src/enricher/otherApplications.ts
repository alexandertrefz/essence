import type { common, enricher } from "@essence-lang/interfaces"

import { choiceCarried, describeType } from "../helpers/describe"
import { coversApartFromTypeArguments } from "../helpers/types"
import { getAllNamespacesInScope, namespacesTargeting } from "./resolvers"
import { choiceNameIn } from "./spelling"

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

	return [...namespaces].flatMap(([name, namespace]) =>
		namespace.targetType !== null &&
		!targeting.has(name) &&
		Object.hasOwn(namespace.methods, methodName) &&
		coversApartFromTypeArguments(namespace, receiver)
			? [
					`'${name}' declares '${methodName}' for ${describeType(namespace.targetType)}, another application of '${choiceNameIn(choice, scope)}'.`,
				]
			: [],
	)
}
