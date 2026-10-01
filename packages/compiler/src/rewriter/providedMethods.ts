import type { common } from "@essence-lang/interfaces"

import {
	type PreludeNamespace,
	protocolMemberIdentifier,
} from "./stdlibPrelude"

// The user's Protocols that join the prelude, and the const name of each
// provided Method. See "Const names" in DEVELOPMENT.md.

// A coverage table the prelude binds, because a provided Method of its Module
// counts into it from inside the prelude.
export type PreludeCounter = {
	name: string
	modulePath: string
	section: common.typedSimple.CoverageSectionNode
}

// A graph's Protocols with provided Methods, and the counters the prelude binds
// for them. See "Counting provided Methods" in DEVELOPMENT.md.
export function graphProtocolNamespaces(
	modules: Array<{ filePath: string; program: common.typedSimple.Program }>,
	// The counter's name, read off the Module's path.
	counterName: (filePath: string) => string,
): { namespaces: Array<PreludeNamespace>; counters: Array<PreludeCounter> } {
	let namespaces: Array<PreludeNamespace> = []
	let counters: Array<PreludeCounter> = []

	for (let module of modules) {
		let found = protocolPreludeNamespaces([module.program])
		let section = module.program.coverage

		if (found.length === 0 || section === null) {
			namespaces.push(...found)

			continue
		}

		let name = counterName(module.filePath)

		counters.push({ name, modulePath: module.filePath, section })
		namespaces.push(...found.map((entry) => ({ ...entry, counter: name })))
	}

	return { namespaces, counters }
}

// The Programs' Protocols with provided Methods, as prelude entries, so one
// const answers for every conformer.
export function protocolPreludeNamespaces(
	programs: Array<common.typedSimple.Program>,
): Array<PreludeNamespace> {
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

			if (Object.keys(protocol.methods).length > 0) {
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
