export {
	type EssenceValue,
	type RuntimeBridge,
	runtimeBridgeOf,
} from "./bridge"
// NOTE: The other half of the bridge, re-exported from the Compiler, which is
// where a bundle is BUILT with one. A host driving the emit itself — writing its
// own bundles out of `compileToMemory` — needs exactly these, and should not
// have to know that only one of the two halves needs a Compiler.
export {
	BRIDGE_KEY,
	BRIDGE_SPECIFIER,
	withRuntimeBridge,
} from "@essence-lang/compiler/embed"
export { bundlePath, cacheBundle, cachedBundle, cacheDirectory } from "./cache"
export {
	EssenceCompileError,
	// NOTE: The Diagnostic report an `EssenceCompileError` carries, rendered
	// again — with colour, this time, for a host that knows it is writing to a
	// terminal. It is on the root because that is where the Error is.
	renderGroups,
} from "./compile-error"
// NOTE: The Compiler-side half of the boundary. `describe` and its context are
// NOT here: they are how a Descriptor is built one Type at a time, which is a
// thing to reach for on the door it lives behind — and `describe` is a name a
// host has other plans for.
export {
	type CaseDescriptor,
	type ChoiceDescriptor,
	createMarshaller,
	type DeclaredType,
	type Descriptor,
	describeModule,
	describeTypes,
	type ExportDescriptor,
	type FunctionDescriptor,
	type Marshaller,
	type MarshallerOptions,
	type ModuleDescriptor,
	type NamespaceDescriptor,
	type NamespaceMethod,
	type OverloadDescriptor,
} from "./descriptor"
export {
	type DeclarationOptions,
	type DeclarationView,
	generateDeclarations,
} from "./dts"
export {
	EssenceBuildError,
	EssenceCallError,
	EssenceMarshalError,
} from "./errors"
// NOTE: And the run-time half. A host holding a bundle and a Descriptor has
// everything `loadModule` has, which is the whole point of there being one.
export {
	bind,
	type BindOptions,
	createInterpreter,
	type EssenceFunction,
	type Interpreter,
	type ModuleBindings,
} from "./marshal-runtime"
export {
	essenceEsbuild,
	type EsbuildBuild,
	type EsbuildLoadArguments,
	type EsbuildLoadResult,
	type EsbuildPlugin,
	type EsbuildResolveArguments,
	type EsbuildResolveResult,
} from "./esbuild-plugin"
// NOTE: `wrapperFor` is on the root because it is the whole of what a plugin
// does that a host could not have written itself: the Module a build imports,
// spelled out of a Descriptor. A host bundler neither of the two plugins fits
// needs that and its own three hooks.
export {
	declarationsPath,
	type Diagnostics,
	type PluginOptions,
	PRELUDE_ID,
	preludeRequested,
	RAW_SCHEME,
	rawFile,
	rawRequested,
	rawSpecifier,
	servedFile,
	wrapperFor,
	type WrapperOptions,
} from "./plugin-core"
// NOTE: The other way in, for a Module that was compiled already: a bundle and
// the Descriptor beside it, bound without a Compiler. Reached through the root
// like everything else, and importable on its own — `@essence-lang/client/prebuilt`
// pulls in nothing but the interpreter.
export { descriptorPath, loadPrebuilt, type PrebuiltModule } from "./prebuilt"
export {
	essence,
	type PluginContext,
	type ResolvedConfig,
	type VitePlugin,
} from "./vite-plugin"
export type { Input } from "./input"
export { EssenceRational } from "./rational"
// NOTE: Re-exported so a host can spell what `raw` holds — the JavaScript name
// an Essence one is bound under — without importing the Compiler itself.
export { escapeName } from "@essence-lang/compiler/rewriter"
// NOTE: The Compiler's own vocabulary, as far as the signatures below name it.
// A host writing `let host: ModuleHost` or `function report(groups:
// Array<DiagnosticGroup>)` should not have to take a direct dependency on the
// Compiler to spell what this package already handed it — which is the same
// reason `escapeName` is re-exported above.
export type { DiagnosticGroup } from "@essence-lang/compiler/embed"
export type { ExportSurface, ModuleHost } from "@essence-lang/compiler/modules"
export type { OptimiserOptions } from "@essence-lang/compiler/optimiser"

// NOTE: Essence from JavaScript, in one call — see `./load` — and the same
// call kept up to date with its sources, in `./watch`.
export {
	attemptLoad,
	type EssenceModule,
	type LoadAttempt,
	loadModule,
	type LoadOptions,
} from "./load"
export { type ModuleWatcher, watchModule, type WatchOptions } from "./watch"
