import type { common, enricher, parser } from "@essence-lang/interfaces"

import { collectDiagnostics } from "../diagnostics/index"
import { findParserChild, type ParserNode } from "../visitor/index"
import type {
	HoistDiagnosticSink,
	HoistableTypeNode,
	PendingDeclaration,
} from "./enrich"
import {
	derivePredicateAliases,
	type HoistedTypes,
	resolveNamespaceDefinitionStatementType,
	resolveTypeAliasStatementType,
} from "./enrichers"
import {
	invalidateNamespacesInScope,
	referencedTypeNames,
	resolveChoiceDeclarationStatementType,
	resolveFunctionSignatureType,
	resolveOverloadedFunctionStatementType,
	resolveProtocolDeclarationStatementType,
} from "./resolvers"
import { countTypeDeclaration, registerProtocol } from "./scope"

// The Type names a Type declaration mentions. The body is read without the
// declaration's own Type Parameters. A default is read with them, since it
// resolves outside, so `type B<B = B> = { x: Integer }` names itself.
export function typeNamesMentionedBy(
	node: HoistableTypeNode,
): Array<parser.IdentifierNode> {
	let parameters = new Set(
		node.generics.map((generic) => generic.name.content),
	)
	let bodyReferences: Array<parser.IdentifierNode> = []

	if (node.nodeType === "TypeAliasStatement") {
		bodyReferences.push(...referencedTypeNames(node.type))
	} else {
		for (let choiceCase of node.cases) {
			if (choiceCase.type !== null) {
				bodyReferences.push(...referencedTypeNames(choiceCase.type))
			}
		}
	}

	return [
		...node.generics.flatMap((generic) =>
			generic.defaultType === null
				? []
				: referencedTypeNames(generic.defaultType),
		),
		...bodyReferences.filter(
			(reference) => !parameters.has(reference.content),
		),
	]
}

// The Type and Protocol names a Type or Protocol declaration writes.
function declarationNames(
	node: HoistableTypeNode | parser.ProtocolDeclarationStatementNode,
): Array<string> {
	if (node.nodeType !== "ProtocolDeclarationStatement") {
		return [
			...typeNamesMentionedBy(node),
			...node.generics.flatMap((generic) =>
				generic.constraint === null ? [] : [generic.constraint],
			),
		].map((name) => name.content)
	}

	let signatures = Object.values(node.methods).flatMap((method) =>
		"signature" in method ? [method.signature] : method.signatures,
	)

	return [
		...node.conformsTo.map((clause) => clause.protocol),
		...signatures.flatMap((signature) => [
			...signature.parameters.flatMap((parameter) =>
				parameter.type === null
					? []
					: referencedTypeNames(parameter.type),
			),
			...referencedTypeNames(signature.returnType),
		]),
	].map((name) => name.content)
}

// Puts each declaration still waiting once the rounds end into Scope holding
// its Error, where that Error is final. See "Declarations that never resolve"
// in DEVELOPMENT.md.
export function hoistRefusedDeclarations(
	pendingNodes: Array<PendingDeclaration>,
	sink: HoistDiagnosticSink,
	hoistedTypes: HoistedTypes,
): void {
	let waiting = hoistRefusedTypes(pendingNodes, sink, hoistedTypes)

	hoistRefusedFunctions(
		hoistRefusedNamespaces(waiting, sink, hoistedTypes),
		sink,
		hoistedTypes,
	)
}

// Hoists each Type or Protocol that names no declaration still waiting in its
// Scope. One that hoists frees what names it, so this repeats until nothing
// hoists. Answers what still waits.
function hoistRefusedTypes(
	pendingNodes: Array<PendingDeclaration>,
	sink: HoistDiagnosticSink,
	hoistedTypes: HoistedTypes,
): Array<PendingDeclaration> {
	let waiting = pendingNodes

	for (;;) {
		let names = new Map<enricher.Scope, Set<string>>()

		for (let { node, scope } of waiting) {
			if (node.nodeType !== "FunctionStatement") {
				names.set(
					scope,
					(names.get(scope) ?? new Set()).add(node.name.content),
				)
			}
		}

		let remaining = waiting.filter(
			({ node, scope }) =>
				(node.nodeType !== "TypeAliasStatement" &&
					node.nodeType !== "ChoiceDeclarationStatement" &&
					node.nodeType !== "ProtocolDeclarationStatement") ||
				declarationNames(node).some(
					(name) =>
						name !== node.name.content &&
						names.get(scope)?.has(name) === true,
				) ||
				!hoistRefused(node, scope, sink, hoistedTypes),
		)

		if (remaining.length === waiting.length) {
			return remaining
		}

		waiting = remaining
	}
}

// Resolves a declaration once more and puts it into Scope holding its Error,
// with its Diagnostics handed to the sink. A taken name, or a throw, leaves it
// to the in-order enrichment.
function hoistRefused(
	node: HoistableTypeNode | parser.ProtocolDeclarationStatementNode,
	scope: enricher.Scope,
	sink: HoistDiagnosticSink,
	hoistedTypes: HoistedTypes,
): boolean {
	let protocol = node.nodeType === "ProtocolDeclarationStatement"
	let target = protocol ? scope.protocols : scope.types

	if (target[node.name.content] != null) {
		return false
	}

	let resolved: {
		result: common.Type | common.ProtocolType
		diagnostics: Array<common.Diagnostic>
	}

	try {
		resolved = collectDiagnostics((): common.Type | common.ProtocolType =>
			node.nodeType === "ProtocolDeclarationStatement"
				? resolveProtocolDeclarationStatementType(node, scope)
				: node.nodeType === "TypeAliasStatement"
					? resolveTypeAliasStatementType(node, scope)
					: resolveChoiceDeclarationStatementType(node, scope),
		)
	} catch {
		return false
	}

	sink(node, resolved.diagnostics)
	target[node.name.content] = resolved.result
	countTypeDeclaration()
	hoistedTypes.set(node, resolved.result)

	if (resolved.result.type === "Protocol") {
		registerProtocol(scope, resolved.result)
	}

	return true
}

// Hoists each Function whose signature names no declaration still waiting in
// its Scope.
function hoistRefusedFunctions(
	pendingNodes: Array<PendingDeclaration>,
	sink: HoistDiagnosticSink,
	hoistedTypes: HoistedTypes,
): void {
	let waiting = new Map<enricher.Scope, Set<string>>()

	for (let { node, scope } of pendingNodes) {
		if (node.nodeType !== "FunctionStatement") {
			let names = waiting.get(scope) ?? new Set<string>()

			waiting.set(scope, names.add(node.name.content))
		}
	}

	for (let { node, scope } of pendingNodes) {
		if (
			node.nodeType !== "FunctionStatement" ||
			signatureTypeNames(node.value).some(
				(name) => waiting.get(scope)?.has(name) === true,
			) ||
			scope.members[node.name.content] != null
		) {
			continue
		}

		let resolved: {
			result: common.FunctionType
			diagnostics: Array<common.Diagnostic>
		}

		// A throw leaves the Function to the in-order enrichment.
		try {
			resolved = collectDiagnostics(() =>
				resolveFunctionSignatureType(node.value, scope),
			)
		} catch {
			continue
		}

		sink(node, resolved.diagnostics)
		scope.members[node.name.content] = resolved.result
		scope.constants.add(node.name.content)
		countTypeDeclaration()
		invalidateNamespacesInScope(scope, node.name.content, resolved.result)
		hoistedTypes.set(node, resolved.result)
	}
}

// The Type and Protocol names a Function's signature writes.
function signatureTypeNames(
	node: parser.FunctionDefinitionNode,
): Array<string> {
	let written = [
		...node.parameters.map((parameter) => parameter.type),
		node.returnType,
		...node.generics.map((generic) => generic.defaultType),
	]

	return [
		...written.flatMap((type) =>
			type === null ? [] : referencedTypeNames(type),
		),
		...node.generics.flatMap((generic) =>
			generic.constraint === null ? [] : [generic.constraint],
		),
	].map((name) => name.content)
}

// Hoists each Namespace or Overload that names no declaration still waiting in
// its Scope, once the refused Types it may name are in Scope. One that hoists
// frees what names it, so this repeats until nothing hoists. Answers what
// still waits.
function hoistRefusedNamespaces(
	pendingNodes: Array<PendingDeclaration>,
	sink: HoistDiagnosticSink,
	hoistedTypes: HoistedTypes,
): Array<PendingDeclaration> {
	let waiting = pendingNodes

	for (;;) {
		let names = new Map<enricher.Scope, Set<string>>()

		for (let { node, scope } of waiting) {
			names.set(
				scope,
				(names.get(scope) ?? new Set()).add(node.name.content),
			)
		}

		let remaining = waiting.filter(({ node, scope }) => {
			if (
				node.nodeType !== "NamespaceDefinitionStatement" &&
				node.nodeType !== "OverloadedFunctionStatement"
			) {
				return true
			}

			let others = new Set(names.get(scope))

			others.delete(node.name.content)

			return (
				namesAny(node, others) ||
				!hoistRefusedNamespace(node, scope, sink, hoistedTypes)
			)
		})

		if (remaining.length === waiting.length) {
			return remaining
		}

		waiting = remaining
	}
}

// Whether a Namespace or Overload writes one of `names` outside its Methods'
// bodies, which its resolution does not read.
function namesAny(
	node:
		| parser.NamespaceDefinitionStatementNode
		| parser.OverloadedFunctionStatementNode,
	names: ReadonlySet<string>,
): boolean {
	let methods = new Set(
		(node.nodeType === "OverloadedFunctionStatement"
			? node.methods
			: Object.values(node.methods).flatMap((method) =>
					"method" in method
						? [method.method]
						: "methods" in method
							? method.methods
							: [],
				)
		).flatMap((method) =>
			method.nodeType === "FunctionValue" ? [method.value] : [],
		),
	)
	let visit = (child: ParserNode): true | undefined => {
		if (child.nodeType === "Identifier") {
			return names.has(child.content) ? true : undefined
		}

		if (child.nodeType === "FunctionDefinition" && methods.has(child)) {
			return [
				...child.generics,
				...child.parameters,
				...(child.returnType === null ? [] : [child.returnType]),
			].some((part) => visit(part) === true)
				? true
				: undefined
		}

		return findParserChild(child, visit)
	}

	return visit(node) === true
}

// Resolves a Namespace or Overload once more and puts it into Scope holding
// whatever Error it has, with its Diagnostics handed to the sink. A taken
// name, or a throw, leaves it to the in-order enrichment.
function hoistRefusedNamespace(
	node:
		| parser.NamespaceDefinitionStatementNode
		| parser.OverloadedFunctionStatementNode,
	scope: enricher.Scope,
	sink: HoistDiagnosticSink,
	hoistedTypes: HoistedTypes,
): boolean {
	if (scope.members[node.name.content] != null) {
		return false
	}

	let resolved: {
		result: common.Type
		diagnostics: Array<common.Diagnostic>
	}

	try {
		resolved = collectDiagnostics(
			(): common.Type =>
				node.nodeType === "NamespaceDefinitionStatement"
					? resolveNamespaceDefinitionStatementType(node, scope)
					: resolveOverloadedFunctionStatementType(node, scope),
		)
	} catch {
		return false
	}

	sink(node, resolved.diagnostics)
	scope.members[node.name.content] = resolved.result
	scope.constants.add(node.name.content)
	countTypeDeclaration()
	invalidateNamespacesInScope(scope, node.name.content, resolved.result)
	hoistedTypes.set(node, resolved.result)

	if (
		node.nodeType === "NamespaceDefinitionStatement" &&
		resolved.result.type === "Namespace"
	) {
		derivePredicateAliases(node, resolved.result, scope)
	}

	return true
}
