import type { common, parser } from "@essence-lang/interfaces"

import { type Scope, type ScopeRange, scopeAt } from "../rename"
import { overlaps, sliceOf } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk } from "./lookups"

// NOTE: `.price` and `(item) { <- item.price }` are one Function written two
// ways — the Enricher writes the literal out of the path, and nothing
// downstream of enrichment can tell which was typed. Which of them reads
// better is the author's to decide, so both directions are offered and neither
// is preferred.
//
// Only inside an ARGUMENT. A path needs a position that names the Type it
// reads its members off, and while several kinds of position do name one, an
// Argument matched against a one-Parameter Function is the one this can be
// sure of without asking the Enricher what the position expected — everywhere
// else a written path earns `path-without-context` instead. The literal
// direction is offered from the same place so that the two are inverses: an
// action that turns a path into a literal it would then refuse to turn back is
// worse than no action.

// NOTE: What the Diagnostic's own help calls the Parameter it would have
// written — `'(_ item: SomeType) { <- item.price }'` — so the two agree on the
// name a reader is offered.
const preferredName = "item"

export function pathActions(
	program: parser.Program,
	scopes: () => Array<ScopeRange>,
	lines: Array<string>,
	range: common.Position,
	// NOTE: What the Compiler said about this file, so that a path it REFUSED is
	// not offered as a literal — see `pathWasRefused`.
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

// NOTE: Whether the Compiler refused this very path. The rewrite is a change of
// SPELLING and nothing else — it writes the literal the Enricher would have
// written — so over a path that does not work it writes a literal that does not
// work either, and spells the mistake out in more places than the path did:
// `.tags.length` became `(item) { <- item.tags.length }`, which is the same
// refused step, plus a literal with no `-> Type` and a Type Parameter nothing
// binds. One mistake in, three out.
//
// Asked of the reports rather than of the path, because what makes a step wrong
// is what the Types say and this tree holds none of them.
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

// NOTE: The path a literal stands for, or null where the literal does anything
// a path can not — a Parameter carrying a label the path could not write, a
// default it would drop, a body that computes rather than reads, a step that is
// a call. `<- item` alone is left out too: a path is a dot and the members
// after it, and there is no spelling of one that reads nothing.
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

	// NOTE: Measured against the live text, and against the WHOLE literal
	// rather than the chain alone: everything between the brackets is about to
	// be thrown away, so anything in there that no Node accounts for — a
	// Comment above all — would be thrown away with it. Whitespace is the one
	// difference the two spellings are allowed to have.
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

// NOTE: The literal a path stands for. The Parameter takes both its Type and
// its label from the position the Argument fills, exactly as the path did, so
// it is written bare — and the name is the reader's to change afterwards,
// which is why an already taken one is stepped past rather than shadowed.
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

// NOTE: An Argument's value, which is the one position both spellings are
// certainly read in. An `Argument` carries no Position of its own and the walk
// hands out no parents, so the values are collected from the Invocations that
// hold them rather than recognised on the way past.
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
		// NOTE: Never, on the author's rule: the two spellings mean the same
		// thing and an Editor that applied one of them unasked would be making
		// a decision about taste.
		isPreferred: false,
		edits: [{ range, newText }],
	}
}
