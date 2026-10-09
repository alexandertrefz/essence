import type { common } from "@essence-lang/interfaces"
import type * as estree from "estree"

import {
	type PreludeNamespace,
	protocolMemberIdentifier,
} from "./stdlibPrelude"

// The user's Protocols with provided Methods, and the const name of each
// provided Method. See "Const names" in DEVELOPMENT.md.

// Each Module's own Protocols with provided Methods, every provided Method's
// const name, and the Module that declares each. See "Provided Methods in a
// graph" in DEVELOPMENT.md.
export function graphProvidedMethods(
	modules: Array<{ filePath: string; program: common.typedSimple.Program }>,
	prelude: Array<PreludeNamespace>,
): {
	protocols: Map<string, Array<PreludeNamespace>>
	providedMembers: ProvidedMemberIdentifiers
	homes: Map<string, string>
} {
	let protocols = new Map(
		modules.map((module) => [
			module.filePath,
			protocolPreludeNamespaces([module.program], prelude),
		]),
	)
	let providedMembers = providedMemberIdentifiers([
		...prelude,
		...[...protocols.values()].flat(),
	])

	return {
		protocols,
		providedMembers,
		homes: providedMethodHomes(protocols, providedMembers),
	}
}

// The provided Methods each Module exports: only those another Module imports,
// so a lone Module's exports stay its own.
export function providedMethodExports(
	homes: ReadonlyMap<string, string>,
	imports: Array<ReadonlyMap<string, Array<string>>>,
): Map<string, Array<string>> {
	let exported = new Map<string, Array<string>>()
	let imported = new Set(
		imports.flatMap((byHome) => [...byHome.values()].flat()),
	)

	for (let [name, home] of homes) {
		if (imported.has(name)) {
			exported.set(home, [...(exported.get(home) ?? []), name])
		}
	}

	return exported
}

// The Module that declares each of a graph's provided Methods, by const name.
function providedMethodHomes(
	protocolsByModule: ReadonlyMap<string, Array<PreludeNamespace>>,
	provided: ProvidedMemberIdentifiers,
): Map<string, string> {
	let homes = new Map<string, string>()

	for (let [filePath, protocols] of protocolsByModule) {
		for (let protocol of protocols) {
			for (let name of provided
				.get(protocolEntryIdentity(protocol))
				?.values() ?? []) {
				homes.set(name, filePath)
			}
		}
	}

	return homes
}

// A Module's own Protocols' provided Methods, as hoisted Functions that read
// nothing of their Module. A Module of a cycle may call one before this Module
// runs. See "Provided Methods in a graph" in DEVELOPMENT.md.
export function providedMethodDeclarations(
	protocols: Array<PreludeNamespace>,
	provided: ProvidedMemberIdentifiers,
	// The Method's body without the Module's constant pool.
	rewrite: (method: common.typedSimple.Method) => estree.FunctionExpression,
): Array<estree.FunctionDeclaration> {
	return protocols.flatMap((protocol) =>
		Object.entries(protocol.node.methods).map(([memberName, method]) => {
			let { params, body } = rewrite(method)

			return {
				type: "FunctionDeclaration",
				id: {
					type: "Identifier",
					name: provided
						.get(protocolEntryIdentity(protocol))!
						.get(memberName)!,
				},
				params,
				body,
			}
		}),
	)
}

// A coverage counter a provided Method may call before its Module runs. It
// registers the table on its first call. The Module calls it once with no
// point, so a table nothing counted into is still reported.
export function hoistedCoverageCounter(
	name: string,
	counters: estree.Expression,
): Array<estree.Statement> {
	let counter: estree.MemberExpression = {
		type: "MemberExpression",
		object: { type: "Identifier", name },
		property: { type: "Identifier", name: "counter" },
		computed: false,
		optional: false,
	}
	let point: estree.Identifier = { type: "Identifier", name: "point" }
	let value: estree.Identifier = { type: "Identifier", name: "value" }

	return [
		{
			type: "FunctionDeclaration",
			id: { type: "Identifier", name },
			params: [point, value],
			body: {
				type: "BlockStatement",
				body: [
					{
						type: "IfStatement",
						test: {
							type: "BinaryExpression",
							operator: "===",
							left: counter,
							right: { type: "Identifier", name: "undefined" },
						},
						consequent: {
							type: "ExpressionStatement",
							expression: {
								type: "AssignmentExpression",
								operator: "=",
								left: counter,
								right: counters,
							},
						},
						alternate: null,
					},
					{
						type: "ReturnStatement",
						argument: {
							type: "ConditionalExpression",
							test: {
								type: "BinaryExpression",
								operator: "===",
								left: point,
								right: {
									type: "Identifier",
									name: "undefined",
								},
							},
							consequent: value,
							alternate: {
								type: "CallExpression",
								callee: counter,
								arguments: [point, value],
								optional: false,
							},
						},
					},
				],
			},
		},
		{
			type: "ExpressionStatement",
			expression: {
				type: "CallExpression",
				callee: { type: "Identifier", name },
				arguments: [],
				optional: false,
			},
		},
	]
}

// The provided Methods a Module names and another Module declares, grouped by
// the declaring Module.
export function providedMethodImports(
	names: ReadonlySet<string>,
	filePath: string,
	homes: ReadonlyMap<string, string>,
): Map<string, Array<string>> {
	let imports = new Map<string, Array<string>>()

	for (let [name, home] of homes) {
		if (home !== filePath && names.has(name)) {
			imports.set(home, [...(imports.get(home) ?? []), name])
		}
	}

	return imports
}

// The Programs' Protocols with provided Methods, as prelude entries. One const
// answers for every conformer. A Protocol the prelude already holds is left
// out. A standard library source compiled for its `@example` tests declares
// the very Protocols the prelude carries.
export function protocolPreludeNamespaces(
	programs: Array<common.typedSimple.Program>,
	prelude: Array<PreludeNamespace>,
): Array<PreludeNamespace> {
	let held = new Set(
		prelude
			.filter((entry) => entry.protocol === true)
			.map(protocolEntryIdentity),
	)
	let found: Array<PreludeNamespace> = []
	let visited = new Set<unknown>()

	let visit = (value: unknown): void => {
		if (value === null || typeof value !== "object" || visited.has(value)) {
			return
		}

		visited.add(value)

		if (Array.isArray(value)) {
			for (let entry of value) {
				visit(entry)
			}

			return
		}

		let node = value as Record<string, unknown>

		if (node["nodeType"] === "ProtocolDeclarationStatement") {
			let protocol =
				value as common.typedSimple.ProtocolDeclarationStatementNode

			if (
				Object.keys(protocol.methods).length > 0 &&
				!held.has(protocol.identity)
			) {
				found.push({
					name: protocol.name.name,
					protocol: true,
					identity: protocol.identity,
					node: {
						nodeType: "NamespaceDefinitionStatement",
						name: protocol.name,
						properties: {},
						methods: protocol.methods,
						nativeShims: [],
						type: {
							type: "Namespace",
							name: protocol.name.name,
							targetType: null,
							generics: [],
							properties: {},
							methods: {},
						},
						position: protocol.position,
					},
				})
			}
		}

		// A Type holds no Statements, so `type` and `returnType` are skipped.
		for (let [key, entry] of Object.entries(node)) {
			if (key !== "type" && key !== "returnType") {
				visit(entry)
			}
		}
	}

	// A `tests` block may declare a Protocol too.
	for (let program of programs) {
		visit(program.implementation.nodes)
		visit(program.tests?.nodes ?? [])
	}

	return found
}

// Each provided Method's const name, by Protocol identity and Method name.
// See "Const names" in DEVELOPMENT.md.
export type ProvidedMemberIdentifiers = ReadonlyMap<
	string,
	ReadonlyMap<string, string>
>

// Names every provided Method's const, claiming in an order every entry of a
// graph agrees on. See "Const names" in DEVELOPMENT.md.
export function providedMemberIdentifiers(
	prelude: Array<PreludeNamespace>,
): ProvidedMemberIdentifiers {
	let protocols = prelude.filter((entry) => entry.protocol === true)
	let isBare = (entry: PreludeNamespace): boolean =>
		!/[#@]/.test(protocolEntryIdentity(entry))
	let claimOrder = [
		...protocols.filter(isBare),
		...protocols
			.filter((entry) => !isBare(entry))
			.map((entry) => ({ entry, key: declarationKey(entry) }))
			.sort((left, right) => compareKeys(left.key, right.key))
			.map(({ entry }) => entry),
	]
	let claims = new Map<string, number>()
	let table = new Map<string, Map<string, string>>()

	for (let entry of claimOrder) {
		let identity = protocolEntryIdentity(entry)
		let members = table.get(identity) ?? new Map<string, string>()

		table.set(identity, members)

		for (let memberName of Object.keys(entry.node.methods)) {
			// One identity is one declaration, so this never holds.
			if (members.has(memberName)) {
				throw new Error(
					`Two Protocols named '${entry.name}' of one identity provide a Method named '${memberName}'`,
				)
			}

			let pair = `${entry.name} ${memberName}`
			let claim = (claims.get(pair) ?? 0) + 1

			claims.set(pair, claim)
			members.set(
				memberName,
				protocolMemberIdentifier(
					claim === 1 ? entry.name : `${entry.name}_${claim}`,
					memberName,
				),
			)
		}
	}

	return table
}

export function protocolEntryIdentity(entry: PreludeNamespace): string {
	return entry.identity ?? entry.name
}

function declarationKey(entry: PreludeNamespace): [string, number, number] {
	let identity = protocolEntryIdentity(entry)
	let separator = identity.lastIndexOf("#")
	let start = entry.node.position?.start

	return [
		separator === -1 ? "" : identity.slice(0, separator),
		start?.line ?? 0,
		start?.column ?? 0,
	]
}

function compareKeys(
	left: [string, number, number],
	right: [string, number, number],
): number {
	if (left[0] !== right[0]) {
		return left[0] < right[0] ? -1 : 1
	}

	return left[1] - right[1] || left[2] - right[2]
}
