import * as path from "node:path"

import { RUNTIME_DIRECTORY } from "@essence-lang/runtime"

import { MODULE_SCHEME, type ModuleSources } from "../bundler/index"

// A synthetic entry Module hands a bundle's own Type key and value
// constructors out of it, since each bundle mints its own key. See "The runtime
// bridge" in DEVELOPMENT.md.

// Not a file. A specifier resolves to a `.es` path, so nothing in a graph is
// spelled like it, as with the Bundler's `$prelude`.
export const BRIDGE_SPECIFIER = `${MODULE_SCHEME}$bridge`

// An Essence value as JavaScript holds it, opaque on purpose: its Type key is
// the bundle's, not the reading process's.
export type EssenceValue = object

// The bundle's own runtime as a host calls into it. Each constructor tags its
// value with that bundle's Type key.
export type RuntimeBridge = {
	typeKey: symbol
	case: (tag: string, payload?: Record<string, EssenceValue>) => EssenceValue
	integer: (value: number | bigint) => EssenceValue
	rational: (numerator: bigint, denominator: bigint) => EssenceValue
	string: (value: string) => EssenceValue
	boolean: (value: boolean) => EssenceValue
	list: (items: Array<EssenceValue>) => EssenceValue
	record: (fields: Record<string, EssenceValue>) => EssenceValue
	// Present only where the boundary names a Dictionary. The builder answers the
	// position of a repeated key instead of a Dictionary. See "Conditional doors"
	// in DEVELOPMENT.md.
	dictionary?: (
		entries: Array<[EssenceValue, EssenceValue]>,
	) => EssenceValue | number
	dictionaryEntries?: (
		dictionary: EssenceValue,
	) => Array<[EssenceValue, EssenceValue]>
	// Present only where the boundary names a Future or a Started. `future` calls
	// its Function at every start, and `futureAnswer` waits for either kind.
	future?: (run: (context: FutureContext) => unknown) => EssenceValue
	futureContext?: () => FutureContext
	futureAnswer?: (work: EssenceValue, context: FutureContext) => unknown
}

// The context one run of a Future belongs to, as `Future.ts` declares it. Spelled
// out, since the half that reads a bridge back may not name the runtime.
export type FutureContext = {
	signal: AbortSignal
	controller: AbortController
}

type BridgeMember = keyof RuntimeBridge

// One runtime Module and the members a bridge takes out of it.
type BridgeModule = [string, Array<[BridgeMember, string]>]

// Which conditional doors a bridge carries, from `carriesDictionary` and
// `carriesFuture`.
export type BridgeOptions = {
	dictionary?: boolean
	future?: boolean
}

// What a `RuntimeBridge` is made of: each member, its runtime module and its
// name there. The List and Integer entries copy and check a host's input. See
// "The runtime bridge" in DEVELOPMENT.md.
export const RUNTIME_BRIDGE_MODULES: Array<BridgeModule> = [
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

// The Dictionary door, read through the runtime's own `liveEntriesOf`. See
// "Conditional doors" in DEVELOPMENT.md.
const DICTIONARY_BRIDGE_MODULES: Array<BridgeModule> = [
	["type", [["dictionaryEntries", "liveEntriesOf"]]],
	["Dictionary", [["dictionary", "createDictionaryFrom"]]],
]

// The asynchrony door, all from `Future.ts`, which answers for a Started too.
const FUTURE_BRIDGE_MODULES: Array<BridgeModule> = [
	[
		"Future",
		[
			["future", "of"],
			["futureContext", "root"],
			["futureAnswer", "complete"],
		],
	],
]

// The bridge table with each door it carries merged in by runtime module, since
// two entries for one module would not parse.
export function runtimeBridgeModules(
	options: BridgeOptions = {},
): Array<BridgeModule> {
	let doors: Array<Array<BridgeModule>> = []

	if (options.dictionary === true) {
		doors.push(DICTIONARY_BRIDGE_MODULES)
	}

	if (options.future === true) {
		doors.push(FUTURE_BRIDGE_MODULES)
	}

	if (doors.length === 0) {
		return RUNTIME_BRIDGE_MODULES
	}

	let modules: Array<BridgeModule> = RUNTIME_BRIDGE_MODULES.map(
		([fileName, members]) => [fileName, [...members]],
	)

	for (let [fileName, members] of doors.flat()) {
		let existing = modules.find(([name]) => name === fileName)

		if (existing === undefined) {
			modules.push([fileName, [...members]])
		} else {
			existing[1].push(...members)
		}
	}

	return modules
}

// The bridge, named for the compiler's cache key, since bundles with and without
// it differ over the same sources. The doors follow from the sources already.
export const BRIDGE_KEY = `essence-embed-bridge-1:${RUNTIME_BRIDGE_MODULES.map(
	([fileName, members]) =>
		`${fileName}(${members
			.map(([member, name]) => `${name}->${member}`)
			.join(",")})`,
).join(";")}`

// An absolute path into the runtime's source, as the Rewriter spells its own
// imports, resolved and inlined the same way.
function runtimeModule(fileName: string): string {
	return path.join(RUNTIME_DIRECTORY, `${fileName}.ts`)
}

// `$bridge_type`, `$bridge_Integer`: the `$` keeps them clear of the names
// `export *` brings in.
function moduleAlias(fileName: string): string {
	return `$bridge_${fileName}`
}

// The Modules a compile produced, with the bridge appended as the entry. The
// bridge is the default export, which `export *` never carries, so nothing
// collides with it.
export function withRuntimeBridge(
	sources: ModuleSources,
	options: BridgeOptions = {},
): ModuleSources {
	let modules = runtimeBridgeModules(options)
	let imports = modules.map(
		([fileName]) =>
			`import * as ${moduleAlias(fileName)} from "${runtimeModule(
				fileName,
			)}"`,
	)
	let members = modules.flatMap(([fileName, entries]) =>
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
