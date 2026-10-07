import type { common, enricher, parser } from "@essence-lang/interfaces"

import {
	collectDiagnostics,
	containsErrors,
	report,
} from "../diagnostics/index"
import {
	applyGenericBindings,
	createInferenceContext,
	flattenUnionMembers,
	genericNamesMentioned,
	matchesType,
	matchesTypeWithBindings,
} from "../helpers/types"
import {
	choiceTypeOf,
	namespacesDeclaringMethod,
	partitionInstanceMethodNamespaces,
	resolveMethodLookupNamespacesForReceiverType,
} from "./resolvers"

// A dispatch branch's Namespaces, looked up for the member first. A Case of a
// generic Choice binds no Type Parameter its payload leaves out. Where the
// lookup refuses it, the Case's application is asked, whose Type Arguments the
// Case carries. A provided Method is built for its receiver, so it is always
// asked again. See "Union receivers" in DEVELOPMENT.md.
export function branchNamespaces(
	node: parser.MethodInvocationNode,
	memberType: common.Type,
	scope: enricher.Scope,
): Map<string, common.NamespaceType> {
	let lookUp = (receiver: common.Type) =>
		namespacesDeclaringMethod(
			node.member.content,
			resolveMethodLookupNamespacesForReceiverType(
				receiver,
				node.namespaceSpecifier,
				scope,
			),
			receiver,
			scope,
			node.position,
			node.namespaceSpecifier,
		)

	let found = (
		namespaces: Map<string, common.NamespaceType>,
		diagnostics: Array<common.Diagnostic>,
	) => namespaces.size > 0 && !containsErrors(diagnostics)

	return retried(
		memberType,
		() => applicationOf(memberType, scope),
		lookUp,
		(namespaces, diagnostics) =>
			found(namespaces, diagnostics) &&
			[...namespaces.values()].every(
				(namespace) => namespace.providedBy === undefined,
			),
		found,
	)
}

// Whether a member answers the call, read as the dispatch reads it, for the
// Notes of a member that does not.
export function answersFor(
	node: parser.MethodInvocationNode,
	memberType: common.Type,
	scope: enricher.Scope,
): boolean {
	let namespaces = namespacesDeclaringMethod(
		node.member.content,
		resolveMethodLookupNamespacesForReceiverType(memberType, null, scope),
		memberType,
		scope,
		node.position,
	)

	return (
		partitionInstanceMethodNamespaces(node.member.content, namespaces)
			.instanceNamespaces.size > 0
	)
}

// A dispatch branch's Method, resolved against the member first, and against
// the Case's application where the member leaves a Type Parameter unbound or
// is refused. The application is read off the Namespace's own target, so the
// Choice needs no name where the call is.
export function resolveBranch<
	Resolved extends {
		unboundGenerics: Array<string>
		selectionDiagnostics: Array<common.Diagnostic>
	},
>(
	memberType: common.Type,
	namespaceType: common.NamespaceType,
	scope: enricher.Scope,
	resolve: (receiver: common.Type) => Resolved | undefined,
): Resolved | undefined {
	let settled = (
		resolved: Resolved | undefined,
		diagnostics: Array<common.Diagnostic>,
	) =>
		resolved !== undefined &&
		resolved.unboundGenerics.length === 0 &&
		!containsErrors([...diagnostics, ...resolved.selectionDiagnostics])

	return retried(
		memberType,
		() =>
			applicationThrough(namespaceType, memberType) ??
			applicationOf(memberType, scope),
		resolve,
		settled,
		settled,
	)
}

type Verdict<Result> = (
	result: Result,
	diagnostics: Array<common.Diagnostic>,
) => boolean

// One attempt for the member, and one for its application where the first is
// not `settled`, taken where it `succeeded`. Each attempt reports only once it
// is taken.
function retried<Result>(
	memberType: common.Type,
	applicationFor: () => common.Type | null,
	attempt: (receiver: common.Type) => Result,
	settled: Verdict<Result>,
	succeeded: Verdict<Result>,
): Result {
	let first = collectDiagnostics(() => attempt(memberType))
	let application = settled(first.result, first.diagnostics)
		? null
		: applicationFor()
	let second =
		application === null
			? null
			: collectDiagnostics(() => attempt(application))
	let taken =
		second !== null && succeeded(second.result, second.diagnostics)
			? second
			: first

	taken.diagnostics.forEach(report)

	return taken.result
}

// The application of a generic Choice a Case belongs to, through the Choice's
// name where the call is, or null.
function applicationOf(
	memberType: common.Type,
	scope: enricher.Scope,
): common.Type | null {
	return memberType.type === "Case" && memberType.typeArguments !== undefined
		? choiceTypeOf(memberType, scope)
		: null
}

// The Namespace's target applied to the Case's Type Arguments, which its Case
// of the same tag is matched against to bind its Type Parameters. Null unless
// that binds every Type Parameter the target mentions, once each, and the
// applied Case takes the member's Type Arguments.
function applicationThrough(
	namespaceType: common.NamespaceType,
	memberType: common.Type,
): common.Type | null {
	let target = namespaceType.targetType

	if (memberType.type !== "Case" || target === null) {
		return null
	}

	let mentioned = [...genericNamesMentioned(target)]
	let memberArguments = memberType.typeArguments ?? []

	for (let arm of sameCaseArms(target, memberType)) {
		let armArguments = arm.typeArguments ?? []
		let context = createInferenceContext(
			mentioned.map((name) => ({ name, infer: true, defaultType: null })),
		)
		let bound =
			mentioned.length > 0 &&
			armArguments.length === memberArguments.length &&
			armArguments.every((argument, index) =>
				matchesTypeWithBindings(
					argument,
					memberArguments[index],
					context,
				),
			) &&
			mentioned.every((name) => context.bindings.has(name))
		let applied = bound
			? applyGenericBindings(target, context.bindings)
			: null

		if (
			applied !== null &&
			sameCaseArms(applied, memberType).some((appliedArm) =>
				takesArguments(appliedArm, memberType),
			)
		) {
			return applied
		}
	}

	return null
}

// Whether an applied Case takes every Type Argument of the member's.
function takesArguments(
	applied: common.CaseType,
	memberType: common.CaseType,
): boolean {
	let appliedArguments = applied.typeArguments ?? []
	let memberArguments = memberType.typeArguments ?? []

	return (
		appliedArguments.length === memberArguments.length &&
		appliedArguments.every((argument, index) =>
			matchesType(argument, memberArguments[index]),
		)
	)
}

function sameCaseArms(
	target: common.Type,
	memberType: common.CaseType,
): Array<common.CaseType> {
	let arms =
		target.type === "UnionType" ? flattenUnionMembers(target) : [target]

	return arms.filter(
		(arm): arm is common.CaseType =>
			arm.type === "Case" &&
			arm.choice === memberType.choice &&
			arm.name === memberType.name,
	)
}

// The Type Parameters a branch reports unbound. The first member reports
// every one, since the shared Arguments decide them. A later member reports
// only those its Method takes a witness for, which it would run without.
export function unboundToReport(
	resolved: Resolution & { unboundGenerics: Array<string> },
	node: parser.MethodInvocationNode,
	first: boolean,
): Array<string> {
	let witnessed = witnessedGenerics(resolved, node)

	return first
		? resolved.unboundGenerics
		: resolved.unboundGenerics.filter((name) => witnessed.includes(name))
}

type Resolution = {
	namespaceType: common.NamespaceType
	overloadedMethodIndex: number | null
}

// Whether the Method a branch resolved to takes a witness Parameter: a bounded
// Type Parameter of its own, or a Protocol's conformance that provides it.
export function takesWitnesses(
	resolved: Resolution,
	node: parser.MethodInvocationNode,
): boolean {
	return (
		resolved.namespaceType.providedBy !== undefined ||
		signatureOf(resolved, node) === undefined ||
		witnessedGenerics(resolved, node).length > 0
	)
}

function witnessedGenerics(
	resolved: Resolution,
	node: parser.MethodInvocationNode,
): Array<string> {
	return (signatureOf(resolved, node)?.generics ?? [])
		.filter((generic) => (generic.constraint ?? null) !== null)
		.map((generic) => generic.name)
}

function signatureOf(
	resolved: Resolution,
	node: parser.MethodInvocationNode,
): common.BaseFunction | undefined {
	let method = resolved.namespaceType.methods[node.member.content]
	let index = resolved.overloadedMethodIndex

	if (method?.type === "SimpleMethod") {
		return method
	}

	return method?.type === "OverloadedMethod" && index !== null
		? method.overloads[index]
		: undefined
}
