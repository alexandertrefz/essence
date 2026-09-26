import type { common, parser } from "@essence-lang/interfaces"

import { conformanceParameterName } from "./names"
import { patternBindings } from "./patterns"
import { resolveOverloadedMethodName, typeMentionsGeneric } from "./types"

// NOTE: How much of `Self` a value may hold: none of it, exactly `Self`, or
// `Self` somewhere inside it.
type Reach = "none" | "self" | "holds"

// NOTE: The entries of its Protocol's witness a provided body reads: the Methods
// it names after `::` or on `Self`, or every entry where `@` or a value of `Self`
// may reach anything but a call of one of those, which hands the witness on.
export function providedBodyReads(
	body: parser.FunctionDefinitionNode,
	signature: common.MethodType,
	methods: Record<string, common.MethodType>,
): Array<string> {
	let named = new Set<string>()
	let whole = false

	eachRecord([body.body, defaultsOf(body)], (record) => {
		if (record.nodeType === "MethodInvocation") {
			noteNamed((record as parser.MethodInvocationNode).member.content)
		} else if (record.nodeType === "Lookup") {
			let lookup = record as parser.LookupNode

			if (namesSelf(lookup.base)) {
				noteNamed(lookup.member.content)
			}
		} else if (
			record.nodeType === "IdentifierTypeDeclaration" &&
			(record as parser.IdentifierTypeDeclarationNode).type.content ===
				"Self"
		) {
			whole = true
		}
	})

	function noteNamed(name: string): void {
		if (Object.hasOwn(methods, name)) {
			named.add(name)
		}
	}

	let reaches = new Map<string, Reach>()
	let heldBy = (name: string): Reach => reaches.get(name) ?? "none"
	let hold = (name: string, reach: Reach): void => {
		let held = reaches.get(name)

		if (reach !== "none") {
			reaches.set(name, held === undefined ? reach : join(held, reach))
		}
	}
	let receiverReach: Reach = "self"
	let parameterTypes =
		signature.type === "SimpleMethod"
			? signature.parameterTypes.slice(1)
			: []

	for (let [index, parameter] of body.parameters.entries()) {
		let reach = reachOfType(parameterTypes[index]?.type)

		if (reach === "none" || parameter.internalName === null) {
			continue
		}

		if (parameter.internalName.nodeType === "Identifier") {
			hold(parameter.internalName.content, reach)
		} else {
			whole = true
		}
	}

	// NOTE: A call of one of the Protocol's own Methods on a value that is
	// exactly `Self` dispatches through the witness, and hands it to nobody.
	let selfCall = (
		receiver: Reach,
		name: string,
		instance: boolean,
	): common.MethodType | null => {
		let method = Object.hasOwn(methods, name) ? methods[name]! : null

		return receiver === "self" &&
			method !== null &&
			isInstanceMethod(method) === instance
			? method
			: null
	}

	let callOf = (
		method: common.MethodType,
		written: Array<parser.ArgumentNode>,
	): Reach => {
		let overloads = signaturesOf(method).map((overload) =>
			overload.parameterTypes.slice(isInstanceMethod(method) ? 1 : 0),
		)
		let wantsSelf = overloads.some((parameters) =>
			parameters.some(
				(parameter) => reachOfType(parameter.type) !== "none",
			),
		)

		for (let [index, argument] of written.entries()) {
			// NOTE: A requirement carries no default, so an Overload of the
			// written arity pairs its Parameters with the Arguments by position.
			let expected = overloads.flatMap((parameters) =>
				parameters.length === written.length
					? [parameters[index]!.type]
					: [],
			)

			reachOf(
				argument.value,
				expected.length === 0
					? wantsSelf
					: expected.some((type) => reachOfType(type) !== "none"),
				expected,
			)
		}

		return signaturesOf(method)
			.map((overload) => reachOfType(overload.returnType))
			.reduce(join)
	}

	// NOTE: Anything else that takes a value of `Self`, or stands where one is
	// expected and may work its Type Parameters out from that, may be handed
	// the witness.
	let otherCall = (
		wanted: boolean,
		callee: Reach,
		written: Array<parser.ArgumentNode>,
	): Reach => {
		let handed = [
			callee,
			...written.map((argument) => reachOf(argument.value, false)),
		]

		if (wanted || handed.some((reach) => reach !== "none")) {
			whole = true
		}

		return "none"
	}

	// NOTE: A Function literal takes each Type it leaves out from the Function
	// Type it is handed as, so a Parameter at a requirement's `Self` is one.
	// Handed as nothing known, a Parameter may hold `Self` where it is wanted.
	let reachOfLiteral = (
		literal: parser.FunctionDefinitionNode,
		wanted: boolean,
		expected: Array<common.Type>,
	): Reach => {
		let inferred = (
			pick: (type: common.FunctionType) => common.Type,
		): Reach =>
			expected.length === 0
				? wanted
					? "holds"
					: "none"
				: expected
						.map((type): Reach => {
							if (
								type.type === "Function" &&
								type.parameterTypes.length ===
									literal.parameters.length
							) {
								return reachOfType(pick(type))
							}

							return reachOfType(type) === "none"
								? "none"
								: "holds"
						})
						.reduce(join)

		for (let [index, parameter] of literal.parameters.entries()) {
			let reach =
				parameter.type === null
					? inferred((type) => type.parameterTypes[index]!.type)
					: "none"

			if (reach === "none" || parameter.internalName === null) {
				continue
			}

			if (parameter.internalName.nodeType === "Identifier") {
				hold(parameter.internalName.content, reach)
			} else {
				whole = true
			}
		}

		return holding([
			reachOfBody(
				literal.body,
				literal.returnType === null &&
					inferred((type) => type.returnType) !== "none",
			),
			...literal.parameters.map((parameter) =>
				parameter.defaultValue === null
					? "none"
					: reachOf(parameter.defaultValue, false),
			),
		])
	}

	let reachOf = (
		expression: parser.ExpressionNode,
		wanted: boolean,
		expected: Array<common.Type> = [],
	): Reach => {
		switch (expression.nodeType) {
			case "Self":
				return receiverReach
			case "Identifier":
				return heldBy(expression.content)
			case "StringValue":
			case "IntegerValue":
			case "RationalValue":
			case "BooleanValue":
			case "MemberPath":
				return "none"
			case "InterpolatedStringValue":
				for (let segment of expression.segments) {
					if (
						segment.kind === "expression" &&
						reachOf(segment.expression, false) !== "none"
					) {
						whole = true
					}
				}

				return "none"
			case "ListValue":
				return holding(
					expression.values.map((value) => reachOf(value, wanted)),
				)
			case "RecordValue":
				return holding(
					Object.values(expression.members).map((member) =>
						member.value !== null
							? reachOf(member.value, wanted)
							: member.group === undefined
								? "none"
								: reachOf(member.group, wanted),
					),
				)
			case "CaseValue":
				return expression.value === null
					? "none"
					: holding([reachOf(expression.value, wanted)])
			case "DictionaryValue": {
				let values: Array<Reach> = []

				for (let entry of expression.entries) {
					if (reachOf(entry.key, false) !== "none") {
						whole = true
					}

					values.push(reachOf(entry.value, wanted))
				}

				return holding(values)
			}
			case "Combination": {
				let parts = [
					reachOf(expression.lhs, wanted),
					reachOf(expression.rhs, wanted),
				]

				if (
					expression.brackets === true &&
					parts.some((reach) => reach !== "none")
				) {
					whole = true
				}

				return holding(parts)
			}
			case "FunctionValue":
				return reachOfLiteral(expression.value, wanted, expected)
			case "Lookup":
				if (namesSelf(expression.base)) {
					return "holds"
				}

				return holding([reachOf(expression.base, false)])
			case "MethodInvocation": {
				let receiver = reachOf(expression.base, false)
				let method =
					expression.namespaceSpecifier === null
						? selfCall(receiver, expression.member.content, true)
						: null

				return method === null
					? otherCall(wanted, receiver, expression.arguments)
					: callOf(method, expression.arguments)
			}
			case "FunctionInvocation": {
				let callee = expression.name
				let method =
					callee.nodeType === "Lookup" && namesSelf(callee.base)
						? selfCall("self", callee.member.content, false)
						: null

				return method === null
					? otherCall(
							wanted,
							reachOf(callee, false),
							expression.arguments,
						)
					: callOf(method, expression.arguments)
			}
			case "Match": {
				let scrutinee = reachOf(expression.value, false)

				if (scrutinee !== "none") {
					whole = true
				}

				let outer = receiverReach
				let answers: Array<Reach> = []

				receiverReach = scrutinee

				for (let handler of expression.handlers) {
					if (handler.guard !== null) {
						reachOf(handler.guard, false)
					}

					answers.push(reachOfBody(handler.body, wanted))
				}

				receiverReach = outer

				return holding(answers)
			}
			case "Define":
				for (let arm of expression.arms) {
					reachOf(arm.condition, false)
				}

				return [
					...expression.arms.map((arm) => reachOf(arm.value, wanted)),
					reachOf(expression.otherwise.value, wanted),
				].reduce(join)
			case "Start":
			case "Complete":
				return holding([reachOf(expression.expression, wanted)])
			case "RefusedValue":
				return reachOf(expression.base, wanted)
		}
	}

	// NOTE: What the `<-` of a body answers with, joined.
	let reachOfBody = (
		statements: Array<parser.ImplementationNode>,
		wanted: boolean,
	): Reach => {
		let answers: Array<Reach> = []

		for (let statement of statements) {
			switch (statement.nodeType) {
				case "ConstantDeclarationStatement":
				case "VariableDeclarationStatement": {
					let reach = reachOf(statement.value, false)

					if (statement.name.nodeType === "Identifier") {
						hold(statement.name.content, reach)
					} else if (reach !== "none") {
						for (let binding of patternBindings(statement.name)) {
							hold(binding.name.content, "holds")
						}
					}

					break
				}
				case "VariableAssignmentStatement":
					hold(
						statement.name.content,
						reachOf(statement.value, false),
					)
					break
				case "IfStatement":
					reachOf(statement.condition, false)
					answers.push(reachOfBody(statement.body, wanted))
					break
				case "IfElseStatement":
					reachOf(statement.condition, false)
					answers.push(
						reachOfBody(statement.trueBody, wanted),
						reachOfBody(statement.falseBody, wanted),
					)
					break
				case "ReturnStatement":
					answers.push(reachOf(statement.expression, wanted))
					break
				case "NamespaceDefinitionStatement":
				case "ProtocolDeclarationStatement":
				case "TypeAliasStatement":
				case "ChoiceDeclarationStatement":
				case "FunctionStatement":
				case "OverloadedFunctionStatement":
				case "ExpectStatement":
				case "RequireStatement":
					if (reachesAnything(statement)) {
						whole = true
					}

					break
				default:
					reachOf(statement, false)
			}
		}

		return answers.length === 0 ? "none" : answers.reduce(join)
	}

	// NOTE: `@` or a name holding `Self` anywhere inside a declaration or an
	// assertion, which are not read closely.
	let reachesAnything = (node: parser.ImplementationNode): boolean => {
		let found = false

		eachRecord(node, (record) => {
			if (
				record.nodeType === "Self" ||
				(record.nodeType === "Identifier" &&
					heldBy((record as parser.IdentifierNode).content) !==
						"none")
			) {
				found = true
			}
		})

		return found
	}

	// NOTE: A name may come to hold `Self` after the point where it is first
	// read, so the body is read again until no name holds more.
	let settled = ""

	while (!whole) {
		reachOfBody(
			body.body,
			reachOfType(signaturesOf(signature)[0]?.returnType) !== "none",
		)

		for (let defaultValue of defaultsOf(body)) {
			reachOf(defaultValue, false)
		}

		let now = JSON.stringify([...reaches].sort())

		if (now === settled) {
			break
		}

		settled = now
	}

	return Object.entries(methods).flatMap(([name, method]) =>
		whole || named.has(name) ? witnessEntries(name, method) : [],
	)
}

// NOTE: Whether a body reads every entry of its witness, which is what
// `providedBodyReads` answers wherever it loses sight of `Self`.
export function readsEveryEntry(
	reads: Array<string>,
	methods: Record<string, common.MethodType>,
): boolean {
	return (
		reads.length ===
		Object.entries(methods).flatMap(([name, method]) =>
			witnessEntries(name, method),
		).length
	)
}

// NOTE: The Methods of a Protocol a body reads an entry of.
export function methodsRead(
	reads: Array<string>,
	methods: Record<string, common.MethodType>,
): Record<string, common.MethodType> {
	let read = new Set(reads)

	return Object.fromEntries(
		Object.entries(methods).filter(([name, method]) =>
			witnessEntries(name, method).some((entry) => read.has(entry)),
		),
	)
}

// NOTE: The entries a typed provided body reads: the Methods it calls through
// its witness, those of a Protocol it hands the witness on as, or every entry
// where the witness is named anywhere this does not know.
export function typedBodyReads(
	body: common.typed.FunctionDefinitionNode,
	methods: Record<string, common.MethodType>,
	methodsOf: (identity: string) => Record<string, common.MethodType> | null,
): Array<string> {
	let witness = conformanceParameterName("Self")
	let named = new Set<string>()
	let whole = false
	let seen = new WeakSet<object>()

	let noteHandedOn = (identity: string): void => {
		let handed = methodsOf(identity)

		if (handed === null) {
			whole = true

			return
		}

		for (let [name, method] of Object.entries(handed)) {
			for (let entry of witnessEntries(name, method)) {
				named.add(entry)
			}
		}
	}

	let noteCall = (name: string, overloadIndex: number | null): void => {
		let method = Object.hasOwn(methods, name) ? methods[name]! : null

		if (method === null) {
			whole = true
		} else if (overloadIndex === null || !isOverloaded(method)) {
			for (let entry of witnessEntries(name, method)) {
				named.add(entry)
			}
		} else {
			named.add(resolveOverloadedMethodName(name, overloadIndex))
		}
	}

	let visit = (value: unknown, skipped: ReadonlySet<string>): void => {
		if (whole || typeof value !== "object" || value === null) {
			return
		}

		if (Array.isArray(value)) {
			for (let item of value) {
				visit(item, NOTHING_SKIPPED)
			}

			return
		}

		let record = value as Record<string, unknown>

		// NOTE: A Type names no witness.
		if (typeof record.type === "string" && record.nodeType === undefined) {
			return
		}

		if (seen.has(record)) {
			return
		}

		seen.add(record)

		let skip = new Set(skipped)

		if (record.nodeType === "MethodInvocation") {
			let invocation =
				record as unknown as common.typed.MethodInvocationNode

			if (invocation.namespace.name === witness) {
				noteCall(
					invocation.member.name,
					invocation.overloadedMethodIndex,
				)
				skip.add("namespace")
			}

			for (let branch of invocation.dispatch ?? []) {
				if (branch.namespaceName === witness) {
					noteCall(
						invocation.member.name,
						branch.overloadedMethodIndex,
					)
				}

				visit(branch, new Set(["namespaceName"]))
			}

			skip.add("dispatch")
		} else if (
			record.nodeType === "Lookup" &&
			record.conformanceName === witness
		) {
			noteCall(
				(record as unknown as common.typed.LookupNode).member.content,
				null,
			)
			skip.add("conformanceName")
		} else if (
			typeof record.protocolName === "string" &&
			handsOn(record.source, witness)
		) {
			noteHandedOn(record.protocolName)
			skip.add("source")
		}

		for (let [key, item] of Object.entries(record)) {
			if (skip.has(key) || key === "position") {
				continue
			}

			if (item === witness) {
				whole = true
			} else {
				visit(item, NOTHING_SKIPPED)
			}
		}
	}

	visit(body, NOTHING_SKIPPED)

	return Object.entries(methods).flatMap(([name, method]) =>
		witnessEntries(name, method).filter(
			(entry) => whole || named.has(entry),
		),
	)
}

const NOTHING_SKIPPED: ReadonlySet<string> = new Set()

// NOTE: Whether a Conformance's source is the witness itself, handed on as the
// witness for the Protocol that Conformance names.
function handsOn(source: unknown, witness: string): boolean {
	let parameter = source as common.ConformanceSource | null | undefined

	return parameter?.kind === "parameter" && parameter.name === witness
}

function isOverloaded(
	method: common.MethodType,
): method is common.OverloadedMethodType | common.OverloadedStaticMethodType {
	return (
		method.type === "OverloadedMethod" ||
		method.type === "OverloadedStaticMethod"
	)
}

// NOTE: The witness entries one Method is read under: one per Overload.
function witnessEntries(
	name: string,
	method: common.MethodType,
): Array<string> {
	return isOverloaded(method)
		? method.overloads.map((_, index) =>
				resolveOverloadedMethodName(name, index),
			)
		: [name]
}

function signaturesOf(method: common.MethodType): Array<common.BaseFunction> {
	return isOverloaded(method) ? method.overloads : [method]
}

function isInstanceMethod(method: common.MethodType): boolean {
	return method.type === "SimpleMethod" || method.type === "OverloadedMethod"
}

function reachOfType(type: common.Type | undefined): Reach {
	if (type === undefined) {
		return "none"
	}

	if (type.type === "GenericUse" && type.name === "Self") {
		return "self"
	}

	return typeMentionsGeneric(type, "Self") ? "holds" : "none"
}

function join(one: Reach, other: Reach): Reach {
	return one === other ? one : "holds"
}

// NOTE: A value built from others holds `Self` where any of them does.
function holding(parts: Array<Reach>): Reach {
	return parts.some((reach) => reach !== "none") ? "holds" : "none"
}

function defaultsOf(
	body: parser.FunctionDefinitionNode,
): Array<parser.ExpressionNode> {
	return body.parameters.flatMap((parameter) =>
		parameter.defaultValue === null ? [] : [parameter.defaultValue],
	)
}

function namesSelf(expression: parser.ExpressionNode): boolean {
	return expression.nodeType === "Identifier" && expression.content === "Self"
}

// NOTE: Every Node under a value, in no particular order.
function eachRecord(
	value: unknown,
	visit: (record: { nodeType: string }) => void,
): void {
	if (Array.isArray(value)) {
		for (let item of value) {
			eachRecord(item, visit)
		}
	} else if (typeof value === "object" && value !== null) {
		if (typeof (value as { nodeType?: unknown }).nodeType === "string") {
			visit(value as { nodeType: string })
		}

		for (let [key, item] of Object.entries(value)) {
			if (key !== "position") {
				eachRecord(item, visit)
			}
		}
	}
}
