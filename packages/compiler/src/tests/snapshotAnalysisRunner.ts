// The child half of the restored-library spec in `snapshotCache.spec.ts`:
// sources in on stdin, what each one's analysis decided out. A process builds
// the standard library or restores it once, so each half needs its own.
import type { common } from "@essence-lang/interfaces"

import { analyseSource } from "../analysis"
import { loadStdlib } from "../enricher/stdlib"
import { forEachTypedChild, type TypedNode } from "../visitor/typed"

function describeInvocations(node: TypedNode, lines: Array<string>): void {
	if (node.nodeType === "MethodInvocation") {
		let { line, column } = node.member.position.start

		lines.push(
			`${node.member.name} ${line}:${column} ${node.namespace.name} ${node.namespace.type.providedBy ?? "-"}`,
		)
	}

	forEachTypedChild(node, describeInvocations, lines)
}

function describeAnalysis(source: string): Array<string> {
	let { program, diagnostics } = analyseSource(source, "/restored.es")
	let lines = diagnostics.map(
		(diagnostic: common.Diagnostic) =>
			`${diagnostic.code} ${diagnostic.message}`,
	)

	describeInvocations(program, lines)

	return lines
}

let sources = JSON.parse(await Bun.stdin.text()) as Array<string>
// A restore spends nothing in any stage.
let restored = loadStdlib().timing.enrich === 0

process.stdout.write(
	JSON.stringify({ restored, analyses: sources.map(describeAnalysis) }),
)
