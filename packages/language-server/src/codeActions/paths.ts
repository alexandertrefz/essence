import type { common, parser } from "@essence-lang/interfaces"

import { type Scope, type ScopeRange, scopeAt } from "../rename"
import { overlaps, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk } from "./lookups"

// Rewrites between `.price` and `(item) { <- item.price }`, which the Enricher
// treats as one Function. Which reads better is the author's choice, so both
// directions are offered and neither is preferred.
//
// Only inside an Argument, the one position certain to name the Type a path
// reads from without asking the Enricher. Both directions use it, so each
// rewrite can be turned back.

// The Parameter name the Diagnostic's Help writes, so both offer the same.
const preferredName = "item"

export function pathActions(
	program: parser.Program,
	scopes: () => Array<ScopeRange>,
	lines: Array<string>,
	range: common.Position,
	// The file's Diagnostics, so a refused path is not offered as a literal.
	reported: Array<common.Diagnostic> = [],
): Array<CodeActionEntry> {
	let entries: Array<CodeActionEntry> = []

	for (let value of argumentValues(program)) {
		if (!overlaps(value.position, range)) {
			continue
		}

		if (value.nodeType === "FunctionValue") {
			let path = writtenPathOf(value, lines)

			if (path !== null) {
				entries.push(
					rewrite(
						`Write it as the path '${path}'`,
						value.position,
						path,
					),
				)
			}
		}

		if (value.nodeType === "MemberPath") {
			let literal = pathWasRefused(value, reported)
				? null
				: writtenLiteralOf(value, scopes, lines)

			if (literal !== null) {
				entries.push(
					rewrite(
						"Write it as a Function literal",
						value.position,
						literal,
					),
				)
			}
		}
	}

	return entries
}

// Whether the compiler refused this path. Rewriting a refused path only
// multiplies its errors. The Diagnostics answer this, since the Parser AST
// holds no Types.
function pathWasRefused(
	node: parser.MemberPathNode,
	reported: Array<common.Diagnostic>,
): boolean {
	return reported.some(
		(diagnostic) =>
			(diagnostic.code === "path-step-not-a-record" ||
				diagnostic.code === "path-without-context" ||
				diagnostic.code === "path-on-computed-value") &&
			diagnostic.position !== null &&
			overlaps(node.position, diagnostic.position),
	)
}

// The path a literal stands for. Null where the literal has a label, a
// default, a computed body or a call, or reads only `<- item`.
function writtenPathOf(
	node: parser.FunctionValueNode,
	lines: Array<string>,
): string | null {
	let definition = node.value

	if (definition.parameters.length !== 1 || definition.generics.length > 0) {
		return null
	}

	let [parameter] = definition.parameters

	if (
		parameter.externalName !== null ||
		parameter.defaultValue !== null ||
		parameter.internalName === null ||
		parameter.internalName.nodeType !== "Identifier"
	) {
		return null
	}

	if (
		definition.body.length !== 1 ||
		definition.body[0].nodeType !== "ReturnStatement"
	) {
		return null
	}

	let read = definition.body[0].expression
	let steps: Array<string> = []

	while (read.nodeType === "Lookup") {
		steps.unshift(read.member.content)
		read = read.base
	}

	if (
		steps.length === 0 ||
		read.nodeType !== "Identifier" ||
		read.content !== parameter.internalName.content
	) {
		return null
	}

	// The whole literal is compared with the buffer, ignoring whitespace,
	// so nothing no Node accounts for, such as a Comment, is thrown away.
	let written = [
		sliceOf(lines, definition.parameterListPosition),
		definition.returnType === null
			? ""
			: `->${sliceOf(lines, definition.returnType.position)}`,
		`{<-${[read.content, ...steps].join(".")}}`,
	].join("")

	if (bare(sliceOf(lines, node.position)) !== bare(written)) {
		return null
	}

	return `.${steps.join(".")}`
}

// The literal a path stands for. The Parameter's Type and label come from the
// Argument's position, so it is written bare. A taken name is stepped past
// rather than shadowed.
function writtenLiteralOf(
	node: parser.MemberPathNode,
	scopes: () => Array<ScopeRange>,
	lines: Array<string>,
): string | null {
	let steps = node.steps.map((step) => step.content)

	if (bare(sliceOf(lines, node.position)) !== `.${steps.join(".")}`) {
		return null
	}

	let name = freeName(scopeAt(scopes(), node.position.start))

	return `(${name}) { <- ${[name, ...steps].join(".")} }`
}

function freeName(scope: Scope): string {
	let name = preferredName
	let suffix = 2

	while (isTaken(scope, name)) {
		name = `${preferredName}${suffix}`
		suffix += 1
	}

	return name
}

function isTaken(scope: Scope, name: string): boolean {
	for (
		let current: Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.values.has(name)) {
			return true
		}
	}

	return false
}

// Every Argument's value, collected from the Invocations, since an `Argument`
// has no Position and the walk gives no parents.
function argumentValues(program: parser.Program): Array<parser.ExpressionNode> {
	let values: Array<parser.ExpressionNode> = []

	walk(program, (node) => {
		if (
			node.nodeType === "MethodInvocation" ||
			node.nodeType === "FunctionInvocation"
		) {
			for (let argument of node.arguments) {
				values.push(argument.value)
			}
		}
	})

	return values
}

function bare(text: string): string {
	return text.replace(/\s/g, "")
}

function rewrite(
	title: string,
	range: common.Position,
	newText: string,
): CodeActionEntry {
	return {
		title,
		kind: "refactor.rewrite",
		diagnosticCode: null,
		diagnosticPosition: null,
		// The spellings mean the same, so the choice is the author's.
		isPreferred: false,
		edits: [{ range, newText }],
	}
}
