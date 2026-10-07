import type { common, enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError, secondary } from "../diagnostics/index"
import { describeType, withArticle } from "../helpers/describe"
import { signaturesOf } from "../printType"
import { isPreludeName } from "./namespaceValues"

// The Method exists but is static, so the fix rewrites the call, not the name.
// `memberType` is set only for one member of a Union receiver's dispatch.
export function reportStaticMethodOnValue(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	memberType: common.Type | null,
	staticNamespaces: Map<string, common.NamespaceType>,
	scope: enricher.Scope,
): void {
	let namespaceNames = [...staticNamespaces.keys()]
	let owner = staticNamespaces.get(namespaceNames[0])
	let accepted = staticCallArities(
		owner?.methods[node.member.content],
		node.arguments.length,
	)
	let predicate = inRefinementPredicate(scope)
	// A Declaration is named as it was written, since the Help edits it there.
	let declarationOf = (name: string): string => {
		let declared = staticNamespaces.get(name)?.declaredName

		return declared === undefined
			? `'${name}'`
			: `'${declared}', which this file imports as '${name}',`
	}
	let declaration = declarationOf(namespaceNames[0])

	reportError(
		memberType === null
			? `'${node.member.content}' is a static Method`
			: `'${node.member.content}' is a static Method for ${describeType(memberType)}`,
		node.member.position,
		{
			code: "static-method-on-value",
			labels: [
				primary(
					node.member.position,
					"a static Method is called on its Namespace, not on a value",
				),
				secondary(
					node.base.position,
					`this is ${withArticle(describeType(baseType))}`,
				),
			],
			notes: namespaceNames.map(
				(name) =>
					`${declarationOf(name)} declares '${node.member.content}' as static.`,
			),
			// A static takes no receiver, so the arity decides whether the
			// value belongs among the Arguments. The Help and both Quick Fixes
			// share this answer. A predicate calls nothing but a Method of `@`,
			// so there the only edit is to the declaration, and none to the
			// standard library's.
			helps: predicate
				? isPreludeName(namespaceNames[0], scope)
					? []
					: [
							instanceDeclarationHelp(
								declaration,
								node.member.content,
								accepted,
							),
						]
				: [
						staticCallHelp(
							namespaceNames[0],
							node.member.content,
							accepted,
						),
					],
			// The first Namespace, the one the Help names, since only a
			// declaring Namespace reaches the static.
			...(predicate
				? {}
				: {
						data: {
							kind: "static-owner" as const,
							namespace: namespaceNames[0],
							...accepted,
						},
					}),
		},
	)
}

function inRefinementPredicate(scope: enricher.Scope): boolean {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.isRefinementPredicate === true) {
			return true
		}
	}

	return false
}

// Which rewrite the static's signatures accept: `Namespace.make(value, 1)` or
// `Namespace.make(1)`. Every Overload is asked. A Method that can not be read
// answers yes to both.
function staticCallArities(
	method: common.Type | undefined,
	writtenArguments: number,
): { acceptsValue: boolean; acceptsWithoutValue: boolean } {
	let signatures = method === undefined ? null : signaturesOf(method)

	if (signatures === null || signatures.length === 0) {
		return { acceptsValue: true, acceptsWithoutValue: true }
	}

	let accepts = (count: number) =>
		signatures.some(
			(signature) =>
				count <= signature.parameterTypes.length &&
				count >=
					signature.parameterTypes.filter(
						(parameter) => !parameter.hasDefault,
					).length,
		)

	return {
		acceptsValue: accepts(writtenArguments + 1),
		acceptsWithoutValue: accepts(writtenArguments),
	}
}

// The predicate's Help. A static that takes the value as its first Argument
// keeps that Parameter once `static` goes, so `@` has to stand in for it.
function instanceDeclarationHelp(
	declaration: string,
	methodName: string,
	accepted: { acceptsValue: boolean; acceptsWithoutValue: boolean },
): string {
	let reading =
		accepted.acceptsValue && !accepted.acceptsWithoutValue
			? ", reading '@' in place of its first Parameter"
			: ""

	return `Declare '${methodName}' in ${declaration} without 'static'${reading} — a predicate asks a Method of '@', and a static Method has no receiver.`
}

// The Help built from that answer. Where both or neither fit, it hedges.
function staticCallHelp(
	namespace: string,
	methodName: string,
	accepted: { acceptsValue: boolean; acceptsWithoutValue: boolean },
): string {
	let call = `${namespace}.${methodName}`

	if (accepted.acceptsValue && !accepted.acceptsWithoutValue) {
		return `Write '${call}(…)', passing the value as its first Argument.`
	}

	if (accepted.acceptsWithoutValue && !accepted.acceptsValue) {
		return `Write '${call}(…)' without the value — the signature takes no receiver.`
	}

	return `Write '${call}(…)', passing the value as an Argument if it needs one.`
}
