import type { common, enricher } from "@essence-lang/interfaces"

import {
	bindsDeclaration,
	choiceCarried,
	displayChoiceName,
	isDeclaration,
} from "../helpers/describe"
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

// What to say of a Choice no name here binds: import it under the name its
// Module exports it as, or export it first. Printing also needs a Namespace
// that states it.
export function foreignChoiceRemedy(
	foreign: ForeignChoice,
	protocol: string,
	printing: boolean,
): {
	notes: Array<string>
	helps: Array<string>
	data?: common.DiagnosticData
} {
	let written = foreign.exportedAs ?? foreign.name

	return {
		notes: [
			`A Choice's derived '${protocol}' is found through a name for the Choice, and no name here binds '${foreign.name}'.`,
		],
		helps: [
			printing
				? withImportOf(
						foreign,
						`Declare a Namespace 'for ${written} is ${protocol}' — its body may be empty, since a Choice whose Cases carry no payload prints as their names.`,
					)
				: `${importOf(foreign)}, so its derived '${protocol}' is in scope.`,
		],
		// The import a Quick Fix writes, naming the Module by its canonical
		// path. The language server works out the specifier. For printing it
		// is only the first of two edits.
		...(foreign.exportedAs === null
			? {}
			: {
					data: {
						kind: "import-declaration" as const,
						name: foreign.exportedAs,
						modulePath: foreign.modulePath,
						...(printing ? { partial: true as const } : {}),
					},
				}),
	}
}

// A Help led by the import a Choice no name here binds needs first.
export function withImportOf(
	foreign: ForeignChoice | null,
	help: string,
): string {
	return foreign === null
		? help
		: `${importOf(foreign)}, and ${help[0].toLowerCase()}${help.slice(1)}`
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
