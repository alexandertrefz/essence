import type { common, enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import {
	ambiguousCaseWording,
	bindsDeclaration,
	caseCandidatePrefixes,
	choiceCarried,
	declaredNameOf,
	displayChoiceName,
	isDeclaration,
	spellCaseChoice,
	type Spelling,
	spellType,
} from "../helpers/describe"
import { closestMatch } from "../helpers/suggest"
import {
	flattenUnionMembers,
	type GenericBindings,
	matchesTypeWithBindings,
} from "../helpers/types"
import { modulePathOf } from "./scope"

// The name this Scope binds a declaration under. That is its declared name
// where that binds it, else the nearest name that does, such as an import
// alias. Null where no name here binds it. `carrier` is a Type naming it.
export function writtenNameIn(
	declared: string,
	carrier: common.Type,
	scope: enricher.Scope,
): string | null {
	return (
		bindingIn(
			declared,
			(bound) => bindsDeclaration(bound, declared, carrier),
			scope,
		)?.name ?? null
	)
}

// The name and Type this Scope binds a Choice under, told by the identity its
// Cases carry. A name that binds something else here hides the Choice.
export function choiceBindingIn(
	identity: string,
	scope: enricher.Scope,
): { name: string; type: common.Type } | null {
	return bindingIn(
		displayChoiceName(identity),
		(bound) => choiceCarried(bound) === identity,
		scope,
	)
}

// The other name this Scope binds a Type declared as `name` under, such as the
// alias an import gave it, or null.
export function renamedTypeIn(
	name: string,
	scope: enricher.Scope,
): string | null {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		for (let bound in current.types) {
			let candidate = current.types[bound]

			if (
				bound !== name &&
				isDeclaration(candidate) &&
				declaredNameOf(candidate) === name &&
				typeBoundIn(bound, scope) === candidate
			) {
				return bound
			}
		}
	}

	return null
}

// The name to write for a Choice known by its identity.
export function choiceNameIn(identity: string, scope: enricher.Scope): string {
	return choiceBindingIn(identity, scope)?.name ?? displayChoiceName(identity)
}

// Under another name, only a declaration counts (`isDeclaration`). An Alias
// such as `type Pair = Box<Integer>` names one application, which writes no
// `Pair<…>` and no `Pair#…`.
function bindingIn(
	declared: string,
	binds: (bound: common.Type) => boolean,
	scope: enricher.Scope,
): { name: string; type: common.Type } | null {
	let bound = typeBoundIn(declared, scope)

	if (bound !== null && binds(bound)) {
		return { name: declared, type: bound }
	}

	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		for (let name in current.types) {
			let candidate = current.types[name]

			if (
				name !== declared &&
				isDeclaration(candidate) &&
				binds(candidate) &&
				typeBoundIn(name, scope) === candidate
			) {
				return { name, type: candidate }
			}
		}
	}

	return null
}

// The reader's spelling in this Scope.
export function spellingIn(scope: enricher.Scope): Spelling {
	return (declared, carrier) => writtenNameIn(declared, carrier, scope)
}

// The Choice this Type is, where another Module of this graph declared it and
// no name in this Scope binds it. Its identity says so. A derived conformance
// is found by name, which needs an import. Null otherwise.
export function unboundForeignChoice(
	type: common.Type,
	scope: enricher.Scope,
): ForeignChoice | null {
	let identity = choiceCarried(type)
	let separator = identity === null ? -1 : identity.lastIndexOf("#")

	if (identity === null || separator < 0) {
		return null
	}

	let modulePath = identity.slice(0, separator)
	let name = displayChoiceName(identity)

	if (
		modulePath === "" ||
		modulePath === modulePathOf(scope) ||
		writtenNameIn(name, type, scope) !== null
	) {
		return null
	}

	return {
		identity,
		name,
		exportedAs: exportedChoiceName(identity, modulePath, scope),
		modulePath,
		fileName: modulePath.slice(modulePath.lastIndexOf("/") + 1),
	}
}

// `exportedAs` is null where the declaring Module keeps the Choice private.
export type ForeignChoice = {
	identity: string
	name: string
	exportedAs: string | null
	modulePath: string
	fileName: string
}

// The name the declaring Module exports a Choice under, its declared name
// first. Without a link to ask, the declared name.
function exportedChoiceName(
	identity: string,
	modulePath: string,
	scope: enricher.Scope,
): string | null {
	let declared = displayChoiceName(identity)

	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.exportedTypes === undefined) {
			continue
		}

		let exported = current.exportedTypes(modulePath)

		if (exported === null) {
			return declared
		}

		let names = Object.keys(exported).filter(
			(name) =>
				isDeclaration(exported[name]) &&
				choiceCarried(exported[name]) === identity,
		)

		return names.includes(declared) ? declared : (names[0] ?? null)
	}

	return declared
}

// The declaration of a Choice no name here binds, read off its own Module,
// where it may be private. Null where no link answers.
export function foreignChoiceDeclaration(
	foreign: ForeignChoice,
	scope: enricher.Scope,
): common.Type | null {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (current.moduleTypes !== undefined) {
			let declared = current.moduleTypes(foreign.modulePath)?.[
				foreign.name
			]

			return declared !== undefined &&
				choiceCarried(declared) === foreign.identity
				? declared
				: null
		}
	}

	return null
}

// The Case a Choice declares, for one an Alias of an application holds, as
// `type Crate<W> = Box<W>` holds `Box<W>#Full`. Where only the Alias is
// imported, the Choice is read off its own Module. See "Resolving a Case" in
// DEVELOPMENT.md.
export function declaredCaseOf(
	caseType: common.CaseType,
	scope: enricher.Scope,
): common.CaseType {
	let foreign =
		caseType.typeArguments === undefined
			? null
			: unboundForeignChoice(caseType, scope)
	let declared =
		foreign === null ? null : foreignChoiceDeclaration(foreign, scope)
	let body = declared?.type === "GenericAlias" ? declared.aliasedType : null
	let declaredCase = (
		body?.type === "UnionType" ? flattenUnionMembers(body) : []
	).find(
		(member): member is common.CaseType =>
			member.type === "Case" &&
			member.choice === caseType.choice &&
			member.name === caseType.name,
	)

	return declaredCase ?? caseType
}

// What to say of a Choice no name here binds: import it under the name its
// Module exports it as, or export it first. A Choice its Type Arguments name
// is imported too, since its derive is found the same way. Printing also needs
// a Namespace that states it.
export function foreignChoiceRemedy(
	culprit: common.Type,
	foreigns: Array<ForeignChoice>,
	protocol: string,
	printing: boolean,
	scope: enricher.Scope,
): {
	notes: Array<string>
	helps: Array<string>
	data?: common.DiagnosticData
} {
	let [first] = foreigns as [ForeignChoice, ...Array<ForeignChoice>]
	let spell = spellingAfterImport(scope, foreigns)
	let written =
		culprit.type === "Case"
			? spellCaseChoice(culprit, spell)
			: spellType(culprit, spell)
	let names = foreigns.map((foreign) => `'${foreign.name}'`).join(" or ")

	return {
		notes: [
			`A Choice's derived '${protocol}' is found through a name for the Choice, and no name here binds ${names}.`,
		],
		helps: [
			printing
				? withImportOf(
						foreigns,
						`Declare a Namespace 'for ${written} is ${protocol}' — its body may be empty, since a Choice whose Cases carry no payload prints as their names.`,
					)
				: `${importsOf(foreigns)}, so ${foreigns.length === 1 ? "its" : "their"} derived '${protocol}' is in scope.`,
		],
		// The import a Quick Fix writes, naming the Module by its canonical
		// path. The language server works out the specifier. Where a Namespace
		// or another import is owed too, it is only the first edit.
		...(first.exportedAs === null
			? {}
			: {
					data: {
						kind: "import-declaration" as const,
						name: first.exportedAs,
						modulePath: first.modulePath,
						...(printing || foreigns.length > 1
							? { partial: true as const }
							: {}),
					},
				}),
	}
}

// The Types the imports of these Choices would bind, under the names their
// Modules export them as. A private one is bound under its declared name, as
// once exported. Null where no link answers.
export function importedChoiceTypes(
	foreigns: Array<ForeignChoice>,
	scope: enricher.Scope,
): Record<string, common.Type> | null {
	let types: Record<string, common.Type> = {}

	for (let foreign of foreigns) {
		let declared = foreignChoiceDeclaration(foreign, scope)

		if (declared === null) {
			return null
		}

		types[foreign.exportedAs ?? foreign.name] = declared
	}

	return types
}

// Every Choice of another Module that a Type's spelling names and no name here
// binds, its Type Arguments' too. Null where there is none.
export function foreignChoicesOf(
	type: common.Type,
	scope: enricher.Scope,
): Array<ForeignChoice> | null {
	let found = foreignChoicesSpelled((spell) => spellType(type, spell), scope)

	return found.length === 0 ? null : found
}

// A Help led by the imports the Choices no name here binds need first.
export function withImportOf(
	foreigns: ReadonlyArray<ForeignChoice>,
	help: string,
): string {
	return foreigns.length === 0
		? help
		: `${importsOf(foreigns)}, and ${help[0].toLowerCase()}${help.slice(1)}`
}

// Choices one Module exports under their own names are imported together.
function importsOf(foreigns: ReadonlyArray<ForeignChoice>): string {
	let together = foreigns.every(
		(foreign) =>
			foreign.exportedAs === foreign.name &&
			foreign.modulePath === foreigns[0].modulePath,
	)
	let names = foreigns.map((foreign) => `'${foreign.name}'`)

	return foreigns.length > 1 && together
		? `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are declared in ${foreigns[0].fileName} — import them here`
		: foreigns.map(importOf).join("; ")
}

// The import of a Choice under the name its Module exports it as, or the
// export it needs there first.
function importOf({ name, exportedAs, fileName }: ForeignChoice): string {
	return exportedAs === null
		? `'${name}' is declared in ${fileName}, which does not export it — export it there and import it here`
		: exportedAs === name
			? `'${name}' is declared in ${fileName} — import it here`
			: `'${name}' is declared in ${fileName}, which exports it as '${exportedAs}' — import '${exportedAs}' here`
}

// The reader's spelling once the Help's imports bind the Choices.
export function spellingAfterImport(
	scope: enricher.Scope,
	foreigns: ReadonlyArray<ForeignChoice>,
): Spelling {
	let spell = spellingIn(scope)

	return (declared, carrier) => {
		let foreign = foreigns.find(
			(candidate) => candidate.identity === choiceCarried(carrier),
		)

		return (
			spell(declared, carrier) ??
			(foreign === undefined
				? null
				: (foreign.exportedAs ?? foreign.name))
		)
	}
}

// The Help that widens a bare Case's annotation to its Choice, which a Choice of
// another Module no name here binds needs imported first. `joiner` leads the
// reason, and a Help that `continues` another sentence starts with "or".
export function annotateAtChoiceHelp(
	caseType: common.CaseType,
	scope: enricher.Scope,
	joiner: ":" | ", since",
	continues: boolean = false,
	// The Protocol a Namespace for the Choice must also be declared for, where
	// none conforms it.
	conforming: string | null = null,
): string {
	let foreigns = choicesToImport(caseType, scope)
	let choice = spellCaseChoice(caseType, spellingAfterImport(scope, foreigns))
	let declaring =
		conforming === null
			? ""
			: `, and declare a Namespace for ${choice} that conforms to '${conforming}'`
	let help = withImportOf(
		foreigns,
		`Annotate the value at '${choice}'${joiner} a bare Case binds the Case, not the Choice${declaring}.`,
	)

	return continues ? `or ${help[0].toLowerCase()}${help.slice(1)}` : help
}

// `annotateAtChoiceHelp` for a refused conformance, with the import a Quick Fix
// writes first where no name here binds the Choice. The annotation is the
// second edit, so the import is `partial`.
export function annotateAtChoiceRemedy(
	caseType: common.CaseType,
	scope: enricher.Scope,
): { helps: Array<string>; data?: common.DiagnosticData } {
	let [foreign] = choicesToImport(caseType, scope)

	return {
		helps: [annotateAtChoiceHelp(caseType, scope, ":")],
		...(foreign === undefined || foreign.exportedAs === null
			? {}
			: {
					data: {
						kind: "import-declaration" as const,
						name: foreign.exportedAs,
						modulePath: foreign.modulePath,
						partial: true as const,
					},
				}),
	}
}

// The Choices a bare Case's annotation names that no name here binds: its own,
// and any its Type Arguments name, as `Box<Light>` does.
function choicesToImport(
	caseType: common.CaseType,
	scope: enricher.Scope,
): Array<ForeignChoice> {
	return foreignChoicesSpelled(
		(spell) => spellCaseChoice(caseType, spell),
		scope,
	)
}

// The Choices of other Modules that a spelling names and no name here binds,
// in the order it names them. Each needs an import before the spelling can be
// written.
export function foreignChoicesSpelled(
	spellWith: (spell: Spelling) => string,
	scope: enricher.Scope,
): Array<ForeignChoice> {
	let spell = spellingIn(scope)
	let found = new Map<string, ForeignChoice>()

	spellWith((declared, carrier) => {
		let written = spell(declared, carrier)
		let foreign =
			written === null ? unboundForeignChoice(carrier, scope) : null

		if (foreign !== null && !found.has(foreign.identity)) {
			found.set(foreign.identity, foreign)
		}

		return written
	})

	return [...found.values()]
}

// A generic Alias of an application that writes a Case's application. It comes
// with the Type Argument it takes for each of its Type Parameters, null where
// the Case leaves one open. `type Boxes<A> = Box<List<A>>` writes the
// `Box<List<Integer>>` of `#Full` as `Boxes<Integer>`.
export function aliasWriting(
	candidate: common.CaseType,
	scope: enricher.Scope,
): {
	name: string
	generics: Array<common.GenericDeclaration>
	typeArguments: Array<common.Type | null>
} | null {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		for (let name in current.types) {
			let alias = current.types[name]

			if (
				alias.type !== "GenericAlias" ||
				isDeclaration(alias) ||
				typeBoundIn(name, scope) !== alias
			) {
				continue
			}

			let bindings: GenericBindings = new Map()
			let aliased = (
				alias.aliasedType.type === "UnionType"
					? flattenUnionMembers(alias.aliasedType)
					: [alias.aliasedType]
			).find(
				(arm) =>
					arm.type === "Case" &&
					arm.choice === candidate.choice &&
					arm.name === candidate.name,
			)

			if (
				aliased !== undefined &&
				matchesTypeWithBindings(aliased, candidate, {
					bindableNames: new Set(
						alias.generics.map((generic) => generic.name),
					),
					bindings,
				})
			) {
				return {
					name,
					generics: alias.generics,
					typeArguments: alias.generics.map(({ name: generic }) => {
						let bound = bindings.get(generic)

						return bound === undefined ||
							(bound.type === "GenericUse" &&
								bound.name === generic)
							? null
							: bound
					}),
				}
			}
		}
	}

	return null
}

function typeBoundIn(name: string, scope: enricher.Scope): common.Type | null {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (Object.hasOwn(current.types, name)) {
			return current.types[name]
		}
	}

	return null
}

// Where a bare Case was written, as its report says. A construction in an
// expected Type is applied, and a Matcher writes no Type Arguments.
export type BareCasePosition =
	| "in scope"
	| "in the expected Type"
	| "in the matched Union"

// Shows the qualified spelling for each candidate. A declared generic Choice
// also needs its Type Arguments, written as `<…>`, since its Type Parameter
// names are not in scope at the call. Each Choice is named as this Scope binds
// it, else through a generic Alias that renames it. See `caseCandidatePrefixes`.
export function reportAmbiguousCase(
	caseName: parser.IdentifierNode,
	candidates: Array<common.CaseType>,
	where: BareCasePosition,
	scope: enricher.Scope,
): void {
	let spell = spellingIn(scope)
	// A Choice no name here binds is written through a generic Alias of its
	// application. A Matcher writes no Type Arguments, and a construction writes
	// the Alias's own, since the Alias decides none of them.
	let throughAlias = (
		candidate: common.CaseType,
	): { name: string; generic: boolean } | null => {
		let alias =
			spell(displayChoiceName(candidate.choice), candidate) === null
				? aliasWriting(candidate, scope)
				: null

		if (alias === null || where === "in the matched Union") {
			return alias === null ? null : { name: alias.name, generic: false }
		}

		let bound = alias.typeArguments.flatMap((typeArgument) =>
			typeArgument === null ? [] : [spellType(typeArgument, spell)],
		)

		return bound.length === alias.typeArguments.length
			? { name: `${alias.name}<${bound.join(", ")}>`, generic: false }
			: { name: alias.name, generic: true }
	}
	let prefixes = caseCandidatePrefixes(
		candidates,
		where === "in the expected Type",
		spell,
		throughAlias,
	)
	let choiceNames = prefixes.map((prefix) => prefix.name)
	let wording = ambiguousCaseWording(
		caseName.content,
		candidates,
		where,
		choiceNames.length,
		spell,
	)

	reportError(wording.message, caseName.position, {
		code: "ambiguous-case",
		labels: [primary(caseName.position, wording.label)],
		notes: wording.notes,
		// One Help per prefix, since which was meant is what this can not
		// decide. The builtin `Optional`'s `#Empty` and `#Value` collide
		// with names a Program likely declares.
		helps: prefixes.map(({ name, generic }) =>
			generic
				? `Write '${name}<…>#${caseName.content}' with its Type Arguments to pick '${name}'.`
				: `Write '${name}#${caseName.content}' to pick '${name}'.`,
		),
		// The names alone, one action each in the same order. A fix writes
		// the prefix, and `undecided-type-arguments` then asks for the Type
		// Arguments of a declared generic Choice.
		data: { kind: "choice-candidates", names: choiceNames },
	})
}

// Every name of one kind visible from `scope`, innermost first, which a
// near miss is drawn from.
function namesInScope(
	scope: enricher.Scope,
	kind: "members" | "types" | "protocols",
): Array<string> {
	let names: Array<string> = []
	let searchScope: enricher.Scope | null = scope

	while (searchScope !== null) {
		names.push(...Object.keys(searchScope[kind]))
		searchScope = searchScope.parent
	}

	return names
}

export function suggestionInScope(
	name: string,
	scope: enricher.Scope,
	kind: "members" | "types" | "protocols",
): string | null {
	let suggestion = closestMatch(name, namesInScope(scope, kind))

	return suggestion === null || suggestion === name ? null : suggestion
}

// What `unknown-type` offers: the name an import gave the Type, else a near
// miss. The Quick Fix writes either.
export function unknownTypeRemedy(
	name: string,
	scope: enricher.Scope,
): { helps: Array<string>; data?: common.DiagnosticData } {
	let renamed = renamedTypeIn(name, scope)

	return renamed === null
		? {
				helps: suggestionHelps(name, scope, "types"),
				...suggestionData(suggestionInScope(name, scope, "types")),
			}
		: {
				helps: [
					`Write '${renamed}', the name '${name}' goes by in this file.`,
				],
				...suggestionData(renamed),
			}
}

// A near miss is a Help rather than part of the message, since it is a guess.
export function suggestionHelps(
	name: string,
	scope: enricher.Scope,
	kind: "members" | "types" | "protocols",
): Array<string> {
	let suggestion = suggestionInScope(name, scope, kind)

	return suggestion === null ? [] : [`Did you mean '${suggestion}'?`]
}

// The near miss for the Quick Fix, spread so that no suggestion means no
// `data` key.
export function suggestionData(suggestion: string | null): {
	data?: common.DiagnosticData
} {
	return suggestion === null
		? {}
		: { data: { kind: "suggestion", suggestion } }
}
