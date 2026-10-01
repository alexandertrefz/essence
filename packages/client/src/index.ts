export {
	type EssenceValue,
	type FutureContext,
	type RuntimeBridge,
	runtimeBridgeOf,
} from "./bridge"
// The half of the bridge that writes one into a bundle, from the compiler. A
// host that emits its own bundles out of `compileToMemory` needs these.
export {
	BRIDGE_KEY,
	BRIDGE_SPECIFIER,
	withRuntimeBridge,
} from "@essence-lang/compiler/embed"
export { bundlePath, cacheBundle, cachedBundle, cacheDirectory } from "./cache"
export {
	EssenceCompileError,
	// Renders the report an `EssenceCompileError` carries again, with colour
	// for a host that writes to a terminal.
	renderGroups,
} from "./compile-error"
// The compiler's half of the boundary. `describe` builds a Descriptor one Type
// at a time and stays behind `./descriptor`, since a host has other uses for the
// name.
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
// The run-time half. A host holding a bundle and its Descriptor can do
// everything `loadModule` does.
export {
	bind,
	type BindOptions,
	createInterpreter,
	type EssenceFunction,
	type Interpreter,
	type InterpreterOptions,
	type ModuleBindings,
} from "./marshal-runtime"
export {
	type BunBuild,
	type BunLoadArguments,
	type BunLoadResult,
	type BunPlugin,
	type BunPluginOptions,
	type BunResolveArguments,
	type BunResolveResult,
	essenceBun,
} from "./bun-plugin"
export {
	essenceEsbuild,
	type EsbuildBuild,
	type EsbuildLoadArguments,
	type EsbuildLoadResult,
	type EsbuildPlugin,
	type EsbuildResolveArguments,
	type EsbuildResolveResult,
} from "./esbuild-plugin"
// `wrapperFor` writes the Module a build imports out of a Descriptor. A host
// bundler that no plugin fits needs it beside hooks of its own.
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
// A Module compiled already: a bundle and its Descriptor, bound without a
// compiler. `@essence-lang/client/prebuilt` loads the interpreter and no compiler.
export {
	descriptorPath,
	loadPrebuilt,
	type PrebuiltModule,
	type PrebuiltOptions,
} from "./prebuilt"
export {
	essence,
	type PluginContext,
	type ResolvedConfig,
	type VitePlugin,
} from "./vite-plugin"
export type { Input } from "./input"
export { EssenceRational } from "./rational"
// So a host can spell the JavaScript names `raw` binds without importing the
// compiler.
export { escapeName } from "@essence-lang/compiler/rewriter"
// The compiler's types that this package's signatures name, so a host can
// spell them without depending on the compiler.
export type { DiagnosticGroup } from "@essence-lang/compiler/embed"
export type { ExportSurface, ModuleHost } from "@essence-lang/compiler/modules"
export type { OptimiserOptions } from "@essence-lang/compiler/optimiser"

export {
	attemptLoad,
	type EssenceModule,
	type LoadAttempt,
	loadModule,
	type LoadOptions,
} from "./load"
export { type ModuleWatcher, watchModule, type WatchOptions } from "./watch"
