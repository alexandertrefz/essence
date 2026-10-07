import type { common, enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import {
	countOf,
	describeType,
	displayChoiceName,
	spellChoiceName,
} from "../helpers/describe"
import {
	borrowedGenericName,
	mentionsUnsolvedTypeParameter,
} from "../helpers/types"
import { aliasWriting, spellingIn } from "./spelling"

// The values a Constant or a Variable is declared with, and the arms of a
// `define` declared so, which its annotation decides.
const declaredValues = new WeakSet<parser.ExpressionNode>()

export function markDeclaredValue(value: parser.ExpressionNode): void {
	if (value.nodeType !== "Define") {
		declaredValues.add(value)

		return
	}

	for (let arm of value.arms) {
		markDeclaredValue(arm.value)
	}

	markDeclaredValue(value.otherwise.value)
}

// The one report for every undecided construction, spelled as the source wrote
// it. See "Resolving a Case" in DEVELOPMENT.md. `takesPayload` keeps the
// parentheses where the Case carries members.
export function reportUndecidedTypeArguments(
	construction: string,
	choiceName: string,
	caseName: string,
	choiceGenerics: Array<common.GenericDeclaration>,
	node: parser.CaseValueNode,
	takesPayload: boolean,
	// What the payload bound each Type Parameter to, so the Helps spell the
	// decided half and the label names the missing one. Absent without a
	// payload.
	payloadArguments?: Array<common.Type | undefined>,
): common.ErrorType {
	let parameterNames = choiceGenerics.map((generic) => generic.name)
	let spellings = parameterNames.map((_, index) => {
		let typeArgument = payloadArguments?.[index]

		return typeArgument === undefined ||
			mentionsUnsolvedTypeParameter(typeArgument)
			? null
			: describeType(typeArgument)
	})
	let undecided =
		payloadArguments === undefined
			? undefined
			: parameterNames.filter(
					(_, index) =>
						payloadArguments[index] !== undefined &&
						spellings[index] === null,
				)
	let application = `${choiceName}<${spellings
		.map((spelling) => spelling ?? "…")
		.join(", ")}>`
	let payloadSuffix = takesPayload ? "(…)" : ""
	let applied = `the Type Arguments here — '${application}#${caseName}${payloadSuffix}', with the Type you mean in place of each '…'.`
	let position = node.position

	reportError(
		`Nothing decides the Type Arguments of '${construction}'`,
		position,
		{
			code: "undecided-type-arguments",
			labels: [
				primary(
					position,
					undecidedLabel(parameterNames, undecided, choiceName),
				),
			],
			notes: [
				`'${choiceName}' takes ${countOf(parameterNames.length, "Type Parameter")}: ${quotedNames(parameterNames)}.`,
				undecided === undefined
					? "A Choice's Type Parameters are applied, never inferred — the payload is checked against them, it does not choose them."
					: "A payload binds only the Type Parameters its own members mention — the rest are applied, at the construction or by the position around it.",
			],
			// Only a Declaration's annotation reaches the value, so the first
			// Help stands where one takes it.
			helps: declaredValues.has(node)
				? [
						`Annotate the Declaration this is written into with '${application}', which is what decides them.`,
						`Or apply ${applied}`,
					]
				: [`Apply ${applied}`],
		},
	)

	return { type: "Error" }
}

// The report for an undecided bare Case. Where no name here binds its Choice,
// a generic Alias of its application does, so the Helps write the Alias and
// its own Type Parameters.
export function reportUndecidedBareCase(
	construction: string,
	caseType: common.CaseType,
	choiceGenerics: Array<common.GenericDeclaration>,
	node: parser.CaseValueNode,
	takesPayload: boolean,
	scope: enricher.Scope,
): common.ErrorType {
	let unbound =
		spellingIn(scope)(displayChoiceName(caseType.choice), caseType) === null
	let alias = unbound ? aliasWriting(caseType, scope) : null
	let generics = alias?.generics ?? choiceGenerics
	// An Alias's Type Parameter the Case leaves open is spelled as undecided.
	let payloadArguments = generics.map((generic, index) =>
		alias === null
			? caseType.typeArguments?.[index]
			: (alias.typeArguments[index] ?? {
					type: "GenericUse" as const,
					name: borrowedGenericName(generic.name),
				}),
	)

	return reportUndecidedTypeArguments(
		construction,
		alias?.name ?? spellChoiceName(caseType, spellingIn(scope)),
		node.caseName.content,
		generics,
		node,
		takesPayload,
		takesPayload ? payloadArguments : undefined,
	)
}

// The primary label. With a payload it says which Type Parameters the payload
// decided beside those it left open. Through an Alias that fixes the rest, as
// `type Keyed<V> = Bin<String, V>` does, only writing the Alias decides them.
function undecidedLabel(
	parameterNames: Array<common.GenericName>,
	undecided: Array<common.GenericName> | undefined,
	choiceName: string,
): string {
	if (undecided === undefined) {
		return "no Type Arguments here, and nothing around it decides them"
	}

	let decided = parameterNames.filter((name) => !undecided.includes(name))

	if (decided.length === 0) {
		return "its payload decides none of them"
	}

	return undecided.length === 0
		? `its payload decides ${quotedNames(decided)}, and only writing '${choiceName}' decides the rest`
		: `its payload decides ${quotedNames(decided)}, and nothing decides ${quotedNames(undecided)}`
}

function quotedNames(names: Array<common.GenericName>): string {
	return names.map((name) => `'${name}'`).join(", ")
}
