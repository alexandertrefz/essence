import type { common, enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import { describeType, withArticle } from "../helpers/describe"
import {
	flattenUnionMembers,
	genericNamesMentioned,
	isBoundFunctionType,
	matchArguments,
	matchesType,
} from "../helpers/types"
import type { NameContext } from "./resolvers"

// A name read as a value. A declaration's own name and an assignment's target
// are resolved without this. A refused Namespace is an Error to every reader,
// and the name inside keeps the Namespace's Type for the hover.
export function valueOf(
	identifier: common.typed.IdentifierNode,
	context: NameContext,
): common.typed.ExpressionNode {
	return reportedNamespaceValue(identifier, context)
		? {
				nodeType: "RefusedValue",
				base: identifier,
				position: identifier.position,
				type: { type: "Error" },
			}
		: identifier
}

// A Namespace written where a value goes, as in `Terminal.inspect(Clock)`. No
// Namespace is a value, whoever declared it. A Lookup base and a call are
// answered elsewhere.
function reportedNamespaceValue(
	node: common.typed.IdentifierNode,
	context: NameContext,
): boolean {
	let type = node.type

	if (
		type.type !== "Namespace" ||
		context.readMember !== undefined ||
		context.applied === true
	) {
		return false
	}

	let name = node.content
	let member = memberToRead(type)

	reportError(
		`Namespace '${name}' can not be used as a value`,
		node.position,
		{
			code: "namespace-as-value",
			labels: [primary(node.position, "this names a Namespace")],
			notes: [
				"A Namespace holds Methods and statics, and is no value of its own.",
			],
			helps: [
				member === null
					? `Name a value in its place, since '${name}' declares no member to read.`
					: `Read a member off it, as in '${name}.${member}'.`,
			],
		},
	)

	return true
}

// The member a Help reads off the Namespace. A static Property comes first,
// then a Method that is a value as read, static before not. An Overload set or
// a Protocol-bound Method comes last. Null for a Namespace that declares none.
function memberToRead(namespace: common.NamespaceType): string | null {
	let methods = Object.entries(namespace.methods)
	let values = methods.filter(
		([, method]) =>
			(method.type === "StaticMethod" ||
				method.type === "SimpleMethod") &&
			!isBoundFunctionType(method),
	)
	let ranked = [
		...Object.keys(namespace.properties),
		...values.filter(([, method]) => method.type === "StaticMethod"),
		...values,
		...methods,
	].map((entry) => (typeof entry === "string" ? entry : entry[0]))

	return ranked[0] ?? null
}

// Whether the nearest binding of `name` is the prelude's. A Program's
// declaration of the name shadows it, and the standard library's own load has
// no prelude at all.
export function isPreludeName(name: string, scope: enricher.Scope): boolean {
	for (
		let searchScope: enricher.Scope | null = scope;
		searchScope !== null;
		searchScope = searchScope.parent
	) {
		if (Object.hasOwn(searchScope.members, name)) {
			return searchScope.preludeNames?.has(name) === true
		}
	}

	return false
}

// What `not-a-function` offers for a call on a Namespace, as in `String(5)`.
// Dropping the `()` would leave a Namespace read as a value. What works builds
// a value of the target: a static Method that answers one, the Argument's own
// conversion, or a List Literal of the Arguments.
export function namespaceCallHelps(
	node: parser.FunctionInvocationNode,
	namespace: common.NamespaceType,
	argumentTypes: Array<common.Type>,
	// The Namespaces a value of the Type reaches with `::`.
	namespacesFor: (type: common.Type) => Iterable<common.NamespaceType>,
	// What the position asks the call to be, or null.
	expectedType: common.Type | null,
): Array<string> {
	let name = namespace.name
	let target = namespace.targetType

	if (target === null) {
		return [`Read one of its members, as in '${name}.…'.`]
	}

	let only = node.arguments.length === 1 ? node.arguments[0] : undefined
	let written = node.arguments.map(spelledArgument)
	let spelled = written.every((argument) => argument !== null)
		? written.join(", ")
		: null

	if (
		only !== undefined &&
		only.name === null &&
		matchesType(target, argumentTypes[0])
	) {
		return [
			`Write ${spelled === null ? "the value" : `'${spelled}'`} alone, since it is a value of Type ${describeType(target)} already.`,
		]
	}

	let fitting = staticMethodsFitting(
		namespace,
		node.arguments,
		argumentTypes,
	).filter(
		({ answer }) =>
			matchesType(target, answer) ||
			(wraps(answer, target) &&
				(expectedType === null || matchesType(expectedType, answer))),
	)
	let converts =
		only !== undefined &&
		only.name === null &&
		convertsTo(argumentTypes[0], `to${name}`, target, namespacesFor)

	return [
		...fitting.map(
			({ methodName, answer }) =>
				`Call its static Method with the same Arguments, as '${name}.${methodName}(${spelled ?? "…"})'${matchesType(target, answer) ? "" : `, which answers ${withArticle(describeType(answer))}`}.`,
		),
		...(converts
			? [
					`Convert the value with '::to${name}()'${spelled === null ? "" : `, as '${spelled}::to${name}()'`}.`,
				]
			: []),
		...(target.type === "List" &&
		node.arguments.every((argument) => argument.name === null)
			? [
					`Write the items in a List Literal${spelled === null ? "" : `, as '[${spelled}]'`}.`,
				]
			: []),
	].concat(
		fitting.length === 0 && !converts && target.type !== "List"
			? [
					`Write a value of Type ${genericNamesMentioned(target).size === 0 ? describeType(target) : name} in its place.`,
				]
			: [],
	)
}

// Each static Method of the Namespace with an Overload that takes the
// Arguments as written, and what that Overload answers.
function staticMethodsFitting(
	namespace: common.NamespaceType,
	written: Array<parser.ArgumentNode>,
	argumentTypes: Array<common.Type>,
): Array<{ methodName: string; answer: common.Type }> {
	let matchables = written.map((argument, index) => ({
		name: argument.name?.content ?? null,
		getType: () => argumentTypes[index],
	}))

	return Object.entries(namespace.methods).flatMap(([methodName, method]) => {
		let overloads =
			method.type === "StaticMethod"
				? [method]
				: method.type === "OverloadedStaticMethod"
					? method.overloads
					: []
		let fits = overloads.find(
			(overload) =>
				matchArguments(overload.parameterTypes, matchables).type ===
				"Match",
		)

		return fits === undefined
			? []
			: [{ methodName, answer: fits.returnType }]
	})
}

// Whether a Choice such as `Optional<Integer>` carries the target in a Case,
// so that the call answers it wrapped.
function wraps(answer: common.Type, target: common.Type): boolean {
	return (
		answer.type === "UnionType" &&
		flattenUnionMembers(answer).some(
			(member) =>
				member.type === "Case" &&
				Object.values(member.members).some((member) =>
					matchesType(target, member),
				),
		)
	)
}

// Whether a value of `from` has a Method of this name that takes nothing more
// and answers the target.
function convertsTo(
	from: common.Type,
	methodName: string,
	target: common.Type,
	namespacesFor: (type: common.Type) => Iterable<common.NamespaceType>,
): boolean {
	for (let candidate of namespacesFor(from)) {
		let method = candidate.methods[methodName]
		let overloads =
			method?.type === "SimpleMethod"
				? [method]
				: method?.type === "OverloadedMethod"
					? method.overloads
					: []

		if (
			overloads.some(
				(overload) =>
					overload.parameterTypes.length === 1 &&
					matchesType(target, overload.returnType),
			)
		) {
			return true
		}
	}

	return false
}

// An Argument as a Help writes it back, or null where it is more than a name
// or a plain literal.
function spelledArgument(argument: parser.ArgumentNode): string | null {
	let value = argument.value
	let spelled =
		value.nodeType === "Identifier" || value.nodeType === "IntegerValue"
			? value.nodeType === "Identifier"
				? value.content
				: value.value
			: value.nodeType === "BooleanValue"
				? String(value.value)
				: value.nodeType === "StringValue" &&
					  /^[^"\\{}\n]*$/.test(value.value)
					? `"${value.value}"`
					: null

	return spelled === null || argument.name === null
		? spelled
		: `${argument.name.content}: ${spelled}`
}
