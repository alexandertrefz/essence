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
	// NOTE: The two a bundle carries ONLY where its boundary names a Dictionary
	// — see `runtimeBridgeModules`, which is where that is decided and why. A
	// host meets them as they are declared here: absent, until the Module it
	// loaded has somewhere to put one.
	//
	// NOTE: The builder answers the POSITION of an entry whose key the
	// Dictionary already holds rather than the Dictionary — a `Map` tells its
	// keys apart by `===` and a Dictionary by the key Type's own equality, so
	// two entries of one Map can be one entry here, and the sentence that says
	// so is the marshaller's to write. See `createDictionaryFrom`.
	dictionary?: (
		entries: Array<[EssenceValue, EssenceValue]>,
	) => EssenceValue | number
	dictionaryEntries?: (
		dictionary: EssenceValue,
	) => Array<[EssenceValue, EssenceValue]>
	// NOTE: And the three a bundle carries ONLY where its boundary names a
	// Future or a Started — `carriesFuture` is that question, and
	// `FUTURE_BRIDGE_MODULES` is what it decides.
	//
	// NOTE: `future` BUILDS one out of a JavaScript Function, which is the
	// whole of what a host callback declared to answer work is: the Function is
	// called at every start rather than once, because that is what a
	// description IS. `futureContext` is the context such a run belongs to —
	// a root, with nothing above it — and `futureAnswer` is the wait: it
	// starts a Future under the context it is given and answers the promise,
	// and hands back the promise a Started already holds. One member for both
	// kinds, because the runtime already tells them apart and a second copy of
	// that rule is the only way this side could come to disagree.
	future?: (run: (context: FutureContext) => unknown) => EssenceValue
	futureContext?: () => FutureContext
	futureAnswer?: (work: EssenceValue, context: FutureContext) => unknown
}

// NOTE: The context one run of a Future belongs to — the signal the work reads
// and the controller that stops it, as `Future.ts` declares it. Spelled out here
// rather than imported from the runtime for the reason `EssenceValue` above is
// spelled as `object`: this file is the vocabulary of the DOOR, and the half of
// it that reads a bridge back is the half that may not name the runtime at all.
//
// NOTE: Both halves are ordinary web platform objects rather than Essence
// values, so there is no bundle's Type key in either and a host may hold one of
// its own beside them — which is exactly what the marshaller does with the
// `AbortSignal` a binding is given: it links it to the controller of the root
// every run it starts belongs under.
export type FutureContext = {
	signal: AbortSignal
	controller: AbortController
}

type BridgeMember = keyof RuntimeBridge

// NOTE: One runtime Module and the members a bridge takes out of it.
type BridgeModule = [string, Array<[BridgeMember, string]>]

// NOTE: What the boundary of the Module this bridge is for holds — one flag per
// conditional door, each asked of the Descriptor: `carriesDictionary` and
// `carriesFuture`.
export type BridgeOptions = {
	dictionary?: boolean
	future?: boolean
}

// NOTE: What a `RuntimeBridge` is MADE OF, as one table: the member, the
// runtime module it comes from, and the name inside it. Everything that has to
// know is written out of this one place — the injected Module below, the
// `BRIDGE_KEY` that names a bundle carrying it, and the client plugin's
// wrapper, which imports these same modules by name instead of injecting
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

// NOTE: The Dictionary door, which a bundle carries only where its boundary
// names one. It is apart from the table above because it is not free: the
// builder is the whole of `Dictionary.ts` and the key encoding under it, which
// a bundler can not shake away once a bridge names them — 15,655 bytes measured
// on a Module whose one export hands a Dictionary straight back: 3,173 bytes
// without the door and 18,828 with it. A boundary that can not hold a
// Dictionary anywhere has no use for either, so it is handed neither; see
// `carriesDictionary`, which is the one question every injector asks.
//
// NOTE: The reader is `type.ts`'s rather than the Dictionary Module's, and that
// is not a saving of bytes but of rules: `liveEntriesOf` is where the runtime
// already states what a box's live view IS, versions, generation stamps and
// all, so the way out reads a Dictionary through the same walk its own natives
// do rather than through a second reading of the store.
const DICTIONARY_BRIDGE_MODULES: Array<BridgeModule> = [
	["type", [["dictionaryEntries", "liveEntriesOf"]]],
	["Dictionary", [["dictionary", "createDictionaryFrom"]]],
]

// NOTE: The asynchrony door, carried under the same rule and for the same
// reason: `Future.ts` is the whole of what a run IS — the abort linking, the
// probe for `AbortSignal.any` and the fallback under it, and every combinator
// the standard library binds to that module — and a boundary that can hold no
// Future anywhere has no use for any of it.
//
// NOTE: All three come from `Future.ts`, including the way a run is WAITED for.
// `Started.ts` holds the two Methods a run in flight answers and no door of its
// own: what a Started is and how one is read live in `Future.ts`, and asking
// for a promise through `complete` is asking the runtime the one question it
// already answers for both kinds.
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

// NOTE: The table a bridge is built out of, with each conditional door folded
// in where the Module's boundary names what it is for — merged by runtime
// Module rather than appended, because two entries for one file would import it
// twice under one alias and the injected Module would not parse.
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

// NOTE: What an embedder contributes to a bundle, named for the Compiler's
// cache key. A bundle built through the bridge and one built without it are
// different bytes over identical sources, so they have to be different files —
// otherwise whichever was written first answers for both, and the loser is
// either a build handed exports it never asked for or a load told the bundle
// "exports no runtime bridge".
//
// NOTE: The conditional doors are NOT named here, and they do not have to be:
// which of them a bundle gets is decided by `carriesDictionary` and
// `carriesFuture` out of the Module's own Descriptor, so each is a function of
// the sources this key already stands for. Naming one would mean knowing the
// answer before the graph has been linked, which is exactly when a caller asks
// for this.
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
