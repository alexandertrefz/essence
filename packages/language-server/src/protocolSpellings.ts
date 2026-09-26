import { builtinProtocols } from "@essence-lang/compiler/enricher/builtins"
import { displayProtocolName } from "@essence-lang/compiler/helpers"
import type { common } from "@essence-lang/interfaces"

import type { DocumentAnalysis } from "./analyse"
import { typedProgramNodes } from "./sections"

// NOTE: How a document names each Protocol it can, by identity: what it
// declares, what its import block binds, and the builtins. An alias is used
// only where the document does not bind the declared name to that Protocol.
export function protocolSpellings(
	program: common.typed.Program | null,
	imported: Record<string, common.ProtocolType>,
): (identity: string) => string {
	let bound: Array<[string, common.ProtocolType]> = [
		...Object.entries(builtinProtocols()),
		...Object.entries(imported),
	]

	for (let node of program === null ? [] : typedProgramNodes(program)) {
		if (node.nodeType === "ProtocolDeclarationStatement") {
			bound.push([node.name.content, node.protocolType])
		}
	}

	let names = new Map<string, string>()

	for (let [name, protocol] of bound) {
		if (protocol.name === name || !names.has(protocol.identity)) {
			names.set(protocol.identity, name)
		}
	}

	return (identity) => names.get(identity) ?? displayProtocolName(identity)
}

export function documentProtocolSpellings(
	document: DocumentAnalysis | null,
): (identity: string) => string {
	return protocolSpellings(
		document?.enrichedProgram ?? null,
		document?.module?.imported.protocols ?? {},
	)
}
