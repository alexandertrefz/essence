import * as path from "node:path"

import { RUNTIME_DIRECTORY } from "@essence-lang/runtime"

import { MODULE_SCHEME, type ModuleSources } from "../bundler/index"

// NOTE: Every Essence value carries its Type on a hidden key, and that key is a
// `Symbol` — one MINTED WHEN THE BUNDLE IS EVALUATED, not a shared constant.
// Two bundles therefore tag their values with two different Symbols, and so
// does an embedder's own copy of the runtime: a host that imports
// `typeKeySymbol` from `@essence-lang/runtime` and reads it off a value out of a
// bundle finds nothing there, and every constructor it calls builds a value the
// bundle can not recognise.
//
// The answer is to take the Symbol and the constructors OUT of the bundle that
// is going to hold the values, rather than to guess at them from outside. A
// synthetic Module is appended before bundling and made the entry: it re-exports
// everything the real entry exports, and hands over the runtime's own Type key
// and value constructors beside them — so one `import()` answers with the
// Module's exports and with the tools to build values that Module accepts.
// Nothing sniffs a Symbol by its description anywhere.
//
// NOTE: It lives in the COMPILER because two things build such a bundle and
// neither may depend on the other: `@essence-lang/client`'s `loadModule`, which
// compiles one in memory, and `esc build --embed`, which writes one to disk for
// a host to load later. Reading a bridge back off a bundle is the client's, and
// needs no Compiler at all — see `runtimeBridgeOf` there.

// NOTE: Not a file, and nothing in a graph can be spelled like it — a specifier
// resolves to a `.es` path, and `$` is not one. The same reasoning the Bundler's
// `$prelude` is named under.
export const BRIDGE_SPECIFIER = `${MODULE_SCHEME}$bridge`

// NOTE: An Essence value as JavaScript holds it — deliberately opaque. The
// runtime's own `IntegerType` and friends are keyed by the Symbol the reading
// process minted, and a value built inside a bundle does not carry it, so typing
// these as the runtime's types would typecheck exactly the comparison that can
// never hold. Reading one apart is marshalling's job, and marshalling reads it
// through `typeKey`.
export type EssenceValue = object

// NOTE: The bundle's own runtime, as the host calls into it. Every constructor
// here builds a value tagged with THAT bundle's Type key, which is the only
// kind of value the Module's Functions accept.
export type RuntimeBridge = {
	typeKey: symbol
	case: (tag: string, payload?: Record<string, EssenceValue>) => EssenceValue
	integer: (value: number | bigint) => EssenceValue
	rational: (numerator: bigint, denominator: bigint) => EssenceValue
	string: (value: string) => EssenceValue
	boolean: (value: boolean) => EssenceValue
	list: (items: Array<EssenceValue>) => EssenceValue
	record: (fields: Record<string, EssenceValue>) => EssenceValue
}

type BridgeMember = keyof RuntimeBridge

// NOTE: What a `RuntimeBridge` is MADE OF, as one table: the member, the
// runtime module it comes from, and the name inside it. Everything that has to
// know is written out of this one place — the injected Module below, the
// `BRIDGE_KEY` that names a bundle carrying it, and the client plugin's
// wrapper, which imports these same seven modules by name instead of injecting
// anything. Two paths, one statement of which Functions the boundary is built
// on.
//
// NOTE: The List and Integer entries name `createListFrom` and
// `createIntegerFrom`, the two places this table does not hand over the
// constructor a native would reach for. `createList` TAKES OWNERSHIP of the
// Array it is given — a later append pushes onto it in place — and a host's
// Array is not the host's to give away by calling a Function; `createInteger`
// canonicalises a value but takes it for an integer, which every caller inside
// the runtime is and a host is not. Every caller in there can be read and
// checked; a host cannot, so the copy and the check are made on this side of
// the door, and neither contract reaches a published surface at all.
export const RUNTIME_BRIDGE_MODULES: Array<
	[string, Array<[BridgeMember, string]>]
> = [
	[
		"type",
		[
			["typeKey", "typeKeySymbol"],
			["case", "createCase"],
		],
	],
	["Integer", [["integer", "createIntegerFrom"]]],
	["Rational", [["rational", "createRational"]]],
	["String", [["string", "createString"]]],
	["Boolean", [["boolean", "createBoolean"]]],
	["List", [["list", "createListFrom"]]],
	["Record", [["record", "createRecord"]]],
]

// NOTE: What an embedder contributes to a bundle, named for the Compiler's
// cache key. A bundle built through the bridge and one built without it are
// different bytes over identical sources, so they have to be different files —
// otherwise whichever was written first answers for both, and the loser is
// either a build handed exports it never asked for or a load told the bundle
// "exports no runtime bridge".
export const BRIDGE_KEY = `essence-embed-bridge-1:${RUNTIME_BRIDGE_MODULES.map(
	([fileName, members]) =>
		`${fileName}(${members
			.map(([member, name]) => `${name}->${member}`)
			.join(",")})`,
).join(";")}`

// NOTE: An absolute path into the runtime's source, exactly as the Rewriter
// spells its own imports — the Bundler serves every synthetic Module with the
// runtime's directory as its resolution base, so these resolve and inline the
// same way the emitted Modules' do.
function runtimeModule(fileName: string): string {
	return path.join(RUNTIME_DIRECTORY, `${fileName}.ts`)
}

// NOTE: `$bridge_type`, `$bridge_Integer`. A `$` prefix keeps them clear of the
// Module's own names, which the `export *` above them brings into this scope.
function moduleAlias(fileName: string): string {
	return `$bridge_${fileName}`
}

// NOTE: The Modules a compile produced, with the bridge appended and made the
// entry. The real entry is still bundled — and still runs — it is simply
// imported by one more Module than it was.
//
// NOTE: The bridge is the bundle's DEFAULT export, which is the one name that
// can not collide with anything: `export * from` never carries a default, and no
// Essence export can be emitted as one — the Rewriter escapes every reserved
// word with a `_`. It is also the whole of what a reader has to know, so the
// half of this that reads a bridge back needs no copy of the table above and can
// live where no Compiler is.
export function withRuntimeBridge(sources: ModuleSources): ModuleSources {
	let imports = RUNTIME_BRIDGE_MODULES.map(
		([fileName]) =>
			`import * as ${moduleAlias(fileName)} from "${runtimeModule(
				fileName,
			)}"`,
	)
	let members = RUNTIME_BRIDGE_MODULES.flatMap(([fileName, entries]) =>
		entries.map(
			([member, name]) =>
				`\t${member}: ${moduleAlias(fileName)}.${name},`,
		),
	)
	let source = `${[
		`export * from "${sources.entry}"`,
		...imports,
		"",
		"export default {",
		...members,
		"}",
	].join("\n")}\n`

	return {
		entry: BRIDGE_SPECIFIER,
		sources: new Map([...sources.sources, [BRIDGE_SPECIFIER, source]]),
	}
}
