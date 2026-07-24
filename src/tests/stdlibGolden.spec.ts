import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { derivedEquatableNamespace } from "../enricher/resolvers"
import { loadStdlib } from "../enricher/stdlib"
import type { common } from "../interfaces/index"
import { printSignature, signaturesOf } from "../lsp/printType"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

const harnessFile = "testFiles/StdlibExhaustive.es"
const goldenFile = "src/tests/__golden__/stdlibExhaustive.txt"

type CompiledProgram = {
	output: Array<string>
	// NOTE: The simplified/optimised Program the emitted JavaScript was made
	// from — retained so the label↔call correspondence test can walk each
	// `show(…)` call's second Argument without compiling the harness twice.
	program: common.typedSimple.Program
}

// NOTE: The same stages the CLI runs, minus bundling — mirrored from
// `codeGeneration.spec.ts` rather than shared with it, because that one folds
// `expect` assertions into the pipeline and takes its source inline. This one
// has a single caller, reads from disk, and has to say WHICH stage refused
// before anything is compared to the golden file.
function compileProgram(source: string): CompiledProgram {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		throw new Error(`${harnessFile} does not parse`)
	}

	let enriched = enrich(parsed.program)

	if (containsErrors(enriched.diagnostics)) {
		throw new Error(`${harnessFile} does not enrich`)
	}

	if (containsErrors(validate(enriched.program))) {
		throw new Error(`${harnessFile} does not validate`)
	}

	let simplified = optimise(simplify(enriched.program))
	let javaScript = rewrite(simplified)
	let directory = mkdtempSync(join(tmpdir(), "essence-golden-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((argument) => String(argument)).join(" "))
	}

	try {
		// NOTE: Synchronous on purpose. `await import` would make every caller
		// async for no gain — the emitted module has no top level await, and
		// Bun resolves a `require` of a freshly written file the same way.
		require(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return { output, program: simplified }
}

// NOTE: Each line of the harness output is `"Label => value"`, printed as a
// String — which the runtime renders with its quotes. The separator is ` => `
// and not ` -> ` because a label spells Function Parameters with the arrow of
// their own signature: `List.keepEvery<ItemType>(where: (_ ItemType) ->
// Boolean)`.
function labelOf(line: string): string {
	let text = line.startsWith('"') ? line.slice(1, -1) : line
	let separator = text.indexOf(" => ")

	return separator === -1 ? text : text.slice(0, separator)
}

// NOTE: Every Method a Program can call, spelled the way `StdlibExhaustive.es`
// labels it: the signature `printSignature` produces, minus its return Type.
// A static Property has no signature and is named on its own.
function declaredSignatures(): Array<string> {
	let signatures: Array<string> = []

	for (let [namespaceName, member] of Object.entries(loadStdlib().members)) {
		if (member.type !== "Namespace") {
			continue
		}

		for (let propertyName of Object.keys(member.properties)) {
			signatures.push(`${namespaceName}.${propertyName}`)
		}

		for (let [methodName, method] of Object.entries(member.methods)) {
			for (let signature of signaturesOf(method) ?? []) {
				let label = printSignature(
					signature,
					`${namespaceName}.${methodName}`,
				)

				signatures.push(label.slice(0, label.lastIndexOf(") -> ") + 1))
			}
		}

		// NOTE: A Choice's `is` and `isNot` are DERIVED — no Namespace declares
		// them, so the loop above never sees them, and without this the harness
		// could quietly stop calling them. They are listed under the Namespace
		// that answers at runtime, which is the one the labels name. The Scope
		// only has to resolve the Choice's name back to the Choice, which the
		// target Type already is.
		let derived =
			member.targetType === null
				? null
				: derivedEquatableNamespace(member.targetType, {
						parent: null,
						members: {},
						declarations: {},
						constants: new Set(),
						types: { [namespaceName]: member.targetType },
						protocols: {},
					})

		if (derived !== null && !Object.hasOwn(member.methods, "is")) {
			for (let [methodName, method] of Object.entries(derived.methods)) {
				for (let signature of signaturesOf(method) ?? []) {
					let label = printSignature(
						signature,
						`${derived.name}.${methodName}`,
					)

					signatures.push(
						label.slice(0, label.lastIndexOf(") -> ") + 1),
					)
				}
			}
		}
	}

	return signatures
}

// NOTE: The Simplifier appends `__overload$N` to an Overload entry's emitted
// name. The label names the Method, not the entry, so the suffix is stripped
// before the two are compared.
function demangle(name: string): string {
	return name.replace(/__overload\$\d+$/, "")
}

// NOTE: The `Namespace.method` a call resolves to, gathered from every
// invocation Node anywhere inside an Expression — the same three spellings the
// call graph walker recognises: an instance call is a `MethodInvocation` whose
// `base` names the answering Namespace, a Union-receiver call is a
// `UnionMethodInvocation` with a target per member, and a static call is a
// `FunctionInvocation` off a Namespace `Lookup`. Searching the WHOLE subtree
// rather than only its outermost call is deliberate: it means the check does
// not depend on the tested Method being written outermost, so a later edit that
// wraps a call (`x::foo()::toString()`) does not read as a mislabel.
function callTargetsIn(node: unknown): Set<string> {
	let targets = new Set<string>()

	let visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (let entry of value) {
				visit(entry)
			}

			return
		}

		if (value === null || typeof value !== "object") {
			return
		}

		let candidate = value as { nodeType?: string }

		if (candidate.nodeType === "MethodInvocation") {
			let invocation = value as common.typedSimple.MethodInvocationNode

			targets.add(
				`${invocation.base.name}.${demangle(invocation.member.name)}`,
			)
		}

		if (candidate.nodeType === "UnionMethodInvocation") {
			let invocation =
				value as common.typedSimple.UnionMethodInvocationNode

			for (let dispatch of invocation.cases) {
				targets.add(
					`${dispatch.namespaceName}.${demangle(dispatch.methodName)}`,
				)
			}
		}

		if (candidate.nodeType === "FunctionInvocation") {
			let callee = (value as common.typedSimple.FunctionInvocationNode)
				.name

			if (
				callee.nodeType === "Lookup" &&
				callee.base.nodeType === "Identifier" &&
				callee.base.type.type === "Namespace" &&
				callee.member.nodeType === "Identifier"
			) {
				targets.add(
					`${callee.base.name}.${demangle(callee.member.name)}`,
				)
			}
		}

		for (let entry of Object.values(value)) {
			visit(entry)
		}
	}

	visit(node)

	return targets
}

// NOTE: The `Namespace.member` a Property Lookup reads — a `Lookup` off a
// Namespace base that is NOT a call. `Number.PI` is the only shape this matches
// in the harness, and it is how a Property label (no `(`) is checked against
// its value.
function propertyReadsIn(node: unknown): Set<string> {
	let reads = new Set<string>()

	let visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (let entry of value) {
				visit(entry)
			}

			return
		}

		if (value === null || typeof value !== "object") {
			return
		}

		let candidate = value as { nodeType?: string }

		if (candidate.nodeType === "Lookup") {
			let lookup = value as common.typedSimple.LookupNode

			if (
				lookup.base.nodeType === "Identifier" &&
				lookup.base.type.type === "Namespace"
			) {
				reads.add(`${lookup.base.name}.${lookup.member.name}`)
			}
		}

		for (let entry of Object.values(value)) {
			visit(entry)
		}
	}

	visit(node)

	return reads
}

// NOTE: A label is a printed signature — `List.map<ItemType, Result>(_ …)` or
// `Number.isBetween(_ Number, and: Number)` or the bare `Number.PI` of a
// Property. Its `Namespace.method` base is everything before the Type
// Parameter clause or the Parameter list, with the ` [note]` suffix already
// gone.
function baseOfLabel(label: string): string {
	let withoutNote = label.replace(/ \[[^\]]*\]$/, "")
	let boundary = withoutNote.search(/[<(]/)

	return boundary === -1 ? withoutNote : withoutNote.slice(0, boundary)
}

// NOTE: Every `show(…)` / `showMaybe(…)` call in the harness, paired with the
// Expression Node it prints — walked out of the simplified Program. The
// helper's OWN internal `show(label, match …)` call is skipped, because there
// the first Argument is the `label` Identifier rather than a String literal.
function labelledCalls(
	program: common.typedSimple.Program,
): Array<{ label: string; value: unknown }> {
	let calls: Array<{ label: string; value: unknown }> = []

	let visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (let entry of value) {
				visit(entry)
			}

			return
		}

		if (value === null || typeof value !== "object") {
			return
		}

		let candidate = value as {
			nodeType?: string
			name?: { nodeType?: string; name?: string }
			arguments?: Array<{ value?: unknown }>
		}

		if (
			candidate.nodeType === "FunctionInvocation" &&
			candidate.name?.nodeType === "Identifier" &&
			(candidate.name.name === "show" ||
				candidate.name.name === "showMaybe")
		) {
			let labelNode = candidate.arguments?.[0]?.value as {
				nodeType?: string
				value?: string
			}

			if (labelNode?.nodeType === "StringValue") {
				calls.push({
					label: labelNode.value!,
					value: candidate.arguments![1]!.value,
				})
			}
		}

		for (let entry of Object.values(value)) {
			visit(entry)
		}
	}

	visit(program.implementation.nodes)

	return calls
}

// NOTE: A whole-file `toEqual` on five hundred lines prints five hundred lines
// of red. What a reader needs is the first few lines that differ, each named by
// the Method its label carries.
function describeDifferences(
	golden: Array<string>,
	actual: Array<string>,
): string | null {
	let differences: Array<string> = []

	for (
		let index = 0;
		index < Math.max(golden.length, actual.length);
		index++
	) {
		let goldenLine = golden[index]
		let actualLine = actual[index]

		if (goldenLine === actualLine) {
			continue
		}

		if (differences.length < 5) {
			differences.push(
				[
					`line ${index + 1} — ${labelOf(goldenLine ?? actualLine ?? "")}`,
					`  golden: ${goldenLine ?? "(no line — the golden file is shorter)"}`,
					`  actual: ${actualLine ?? "(no line — the output is shorter)"}`,
				].join("\n"),
			)
		} else {
			differences.push("")
		}
	}

	if (differences.length === 0) {
		return null
	}

	let shown = differences.filter((difference) => difference !== "")
	let hidden = differences.length - shown.length

	// NOTE: The line count is stated even when it matches, because a harness
	// that gained or lost a call shifts every line after it and the diff below
	// reads as a wholesale change rather than the insertion it is.
	return [
		`${differences.length} lines differ — ${golden.length} in the golden file, ${actual.length} printed`,
		...shown,
		hidden === 0 ? "" : `… and ${hidden} more`,
	]
		.filter((part) => part !== "")
		.join("\n")
}

describe("Stdlib Golden", () => {
	let { output, program } = compileProgram(readFileSync(harnessFile, "utf8"))

	// NOTE: The golden file was produced by RUNNING this harness against the
	// TypeScript standard library, never written by hand. It is the record of
	// what the standard library did before its Methods began moving into
	// Essence, so a Method that comes out behaving differently says so by name
	// — which is the whole reason this file exists. Re-capture it only when a
	// change of behaviour is the intent, and never to make this test pass.
	it("prints what the golden file records", () => {
		let golden = readFileSync(goldenFile, "utf8").split("\n")

		// NOTE: The file ends with a newline, as a text file should.
		if (golden.at(-1) === "") {
			golden.pop()
		}

		let differences = describeDifferences(golden, output)

		if (differences !== null) {
			throw new Error(
				`${harnessFile} no longer prints what ${goldenFile} records.\n\n${differences}`,
			)
		}
	})

	// NOTE: The gate that keeps the net exhaustive. A Method added to
	// `src/stdlib` is not covered by anything until it is called here, and a
	// Method that only LOOKS covered — a label that names an Overload the
	// Declaration does not have — is just as wrong.
	it("calls every declared Method of every Namespace", () => {
		let called = new Set(
			output.map((line) => labelOf(line).replace(/ \[[^\]]*\]$/, "")),
		)
		let declared = declaredSignatures()

		let uncalled = declared.filter((signature) => !called.has(signature))
		let unknown = [...called].filter(
			(signature) => !declared.includes(signature),
		)

		expect({ uncalled, unknown }).toEqual({ uncalled: [], unknown: [] })
		expect(declared.length).toBe(new Set(declared).size)
	})

	// NOTE: The coverage gate above compares label STRINGS to declared
	// signatures, and a label is just text the author typed — nothing there
	// forces the call beside it to invoke the Method it names. Without this
	// test, `show("Boolean.or(…)", x::and(y))` would satisfy coverage for `or`
	// while `or` went untested. This closes that hole for the Method NAME: it
	// walks each `show(…)` call out of the simplified Program and asserts the
	// label's `Namespace.method` is among the calls its value Argument actually
	// makes.
	//
	// LIMITATION — this verifies the base `Namespace.method`, NOT the specific
	// Overload the label spells. A label of `Integer.add(_ Rational)` beside a
	// call to the Integer Overload of `add` still passes, because the
	// simplified Node carries a mangled `add__overload$N` name and mapping that
	// number back to a printed signature would duplicate the Simplifier's
	// Overload-numbering — deep plumbing that would couple this test to an
	// internal it should not know. So: a call mislabelled to a different METHOD
	// is caught here; a call mislabelled to a different OVERLOAD of the right
	// Method is not, and the labels' Overload precision rests on the author.
	it("labels each call with a Method the call actually invokes", () => {
		let mismatches: Array<string> = []

		for (let { label, value } of labelledCalls(program)) {
			let base = baseOfLabel(label)
			let isProperty = !label.replace(/ \[[^\]]*\]$/, "").includes("(")
			let resolved = isProperty
				? propertyReadsIn(value)
				: callTargetsIn(value)

			if (!resolved.has(base)) {
				mismatches.push(
					`'${label}' names '${base}', but its call resolves to {${[
						...resolved,
					].join(", ")}}`,
				)
			}
		}

		expect(mismatches).toEqual([])
	})
})
