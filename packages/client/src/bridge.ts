import * as path from "node:path"

import {
	MODULE_SCHEME,
	type ModuleSources,
} from "@essence-lang/compiler/bundler"
import { RUNTIME_DIRECTORY } from "@essence-lang/runtime"

// NOTE: Every Essence value carries its Type on a hidden key, and that key is a
// `Symbol` — one MINTED WHEN THE BUNDLE IS EVALUATED, not a shared constant.
// Two bundles therefore tag their values with two different Symbols, and so
// does this package's own copy of the runtime: a host that imports
// `typeKeySymbol` from `@essence-lang/runtime` and reads it off a value out of a
// bundle finds nothing there, and every constructor it calls builds a value the
// bundle can not recognise.
//
// The answer is to take the Symbol and the constructors OUT of the bundle that
// is going to hold the values, rather than to guess at them from outside. A
// synthetic Module is appended before bundling and made the entry: it re-exports
// everything the real entry exports, and beside them the runtime's own Type key
// and value constructors — so one `import()` answers with the Module's exports
// and with the tools to build values that Module accepts. Nothing sniffs a
// Symbol by its description anywhere.

// NOTE: Not a file, and nothing in a graph can be spelled like it — a specifier
// resolves to a `.es` path, and `$` is not one. The same reasoning the Bundler's
// `$prelude` is named under.
export const BRIDGE_SPECIFIER = `${MODULE_SCHEME}$bridge`

// NOTE: The names the bundle exports the runtime's own values under, and the
// only spellings a host may reach them by.
//
// Each contains a `_`, which is what makes it unreachable by an Essence export
// and therefore impossible to collide with. `export * from` is SHADOWED by an
// explicit export of the same name — the star's copy silently loses — so a name
// a Module could also export would take that Module's binding away without a
// word about it. The Lexer reads `_` as a Symbol, so no Essence identifier
// contains one; the Rewriter's own `_`-bearing outputs are `$user_…` mangles and
// `_`-prefixed reserved words, and neither can begin `$bridge_`. (`$` alone
// would NOT be enough: `$` is a perfectly ordinary Essence identifier character,
// and `constant $$integer = 1` both compiles and exports.)
export const BRIDGE_EXPORTS = {
	typeKey: "$bridge_typeKey",
	case: "$bridge_case",
	integer: "$bridge_integer",
	rational: "$bridge_rational",
	string: "$bridge_string",
	boolean: "$bridge_boolean",
	list: "$bridge_list",
	record: "$bridge_record",
} as const

// NOTE: An Essence value as JavaScript holds it — deliberately opaque. The
// runtime's own `IntegerType` and friends are keyed by the Symbol THIS process
// minted, and a value built inside a bundle does not carry it, so typing these
// as the runtime's types would typecheck exactly the comparison that can never
// hold. Reading one apart is marshalling's job, and marshalling reads it through
// `typeKey`.
export type EssenceValue = object

// NOTE: The bundle's own runtime, as the host calls into it. Every constructor
// here builds a value tagged with THAT bundle's Type key, which is the only
// kind of value the Module's Functions accept.
export type RuntimeBridge = {
	typeKey: symbol
	case: (tag: string, payload?: Record<string, EssenceValue>) => EssenceValue
	integer: (value: bigint) => EssenceValue
	rational: (numerator: bigint, denominator: bigint) => EssenceValue
	string: (value: string) => EssenceValue
	boolean: (value: boolean) => EssenceValue
	list: (items: Array<EssenceValue>) => EssenceValue
	record: (fields: Record<string, EssenceValue>) => EssenceValue
}

// NOTE: An absolute path into the runtime's source, exactly as the Rewriter
// spells its own imports — the Bundler serves every synthetic Module with the
// runtime's directory as its resolution base, so these resolve and inline the
// same way the emitted Modules' do.
function runtimeModule(fileName: string): string {
	return path.join(RUNTIME_DIRECTORY, `${fileName}.ts`)
}

function reExport(fileName: string, members: Array<[string, string]>): string {
	let names = members
		.map(([member, alias]) => `${member} as ${alias}`)
		.join(", ")

	return `export { ${names} } from "${runtimeModule(fileName)}"`
}

// NOTE: The Modules a compile produced, with the bridge appended and made the
// entry. The real entry is still bundled — and still runs — it is simply
// imported by one more Module than it was.
export function withRuntimeBridge(sources: ModuleSources): ModuleSources {
	let source = `${[
		`export * from "${sources.entry}"`,
		reExport("type", [
			["typeKeySymbol", BRIDGE_EXPORTS.typeKey],
			["createCase", BRIDGE_EXPORTS.case],
		]),
		reExport("Integer", [["createInteger", BRIDGE_EXPORTS.integer]]),
		reExport("Rational", [["createRational", BRIDGE_EXPORTS.rational]]),
		reExport("String", [["createString", BRIDGE_EXPORTS.string]]),
		reExport("Boolean", [["createBoolean", BRIDGE_EXPORTS.boolean]]),
		reExport("List", [["createList", BRIDGE_EXPORTS.list]]),
		reExport("Record", [["createRecord", BRIDGE_EXPORTS.record]]),
	].join("\n")}\n`

	return {
		entry: BRIDGE_SPECIFIER,
		sources: new Map([...sources.sources, [BRIDGE_SPECIFIER, source]]),
	}
}

// NOTE: The bridge read back off an imported bundle. A missing name means the
// bundle was not built through `withRuntimeBridge`, which is worth saying out
// loud — the alternative is a `TypeError` about `undefined` from whichever
// constructor a caller happened to reach for first.
export function runtimeBridgeOf(
	namespace: Record<string, unknown>,
): RuntimeBridge {
	return {
		typeKey: read(namespace, BRIDGE_EXPORTS.typeKey) as symbol,
		case: read(namespace, BRIDGE_EXPORTS.case) as RuntimeBridge["case"],
		integer: read(
			namespace,
			BRIDGE_EXPORTS.integer,
		) as RuntimeBridge["integer"],
		rational: read(
			namespace,
			BRIDGE_EXPORTS.rational,
		) as RuntimeBridge["rational"],
		string: read(
			namespace,
			BRIDGE_EXPORTS.string,
		) as RuntimeBridge["string"],
		boolean: read(
			namespace,
			BRIDGE_EXPORTS.boolean,
		) as RuntimeBridge["boolean"],
		list: read(namespace, BRIDGE_EXPORTS.list) as RuntimeBridge["list"],
		record: read(
			namespace,
			BRIDGE_EXPORTS.record,
		) as RuntimeBridge["record"],
	}
}

function read(namespace: Record<string, unknown>, name: string): unknown {
	let value = namespace[name]

	if (value === undefined) {
		throw new Error(
			`The bundle does not export '${name}' — it was not built through ` +
				"the runtime bridge.",
		)
	}

	return value
}
