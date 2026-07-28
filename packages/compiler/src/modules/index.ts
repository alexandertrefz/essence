// NOTE: One stage, one entry in the Compiler's exports map — `@essence-lang/cli` and
// `@essence-lang/language-server` both load a graph, and neither should have to know
// which of the three files inside this directory holds which half of the answer.
export { loadModuleGraph, type Module, type ModuleGraph } from "./graph"
export { diskModuleHost, type ModuleHost } from "./host"
export {
	type DeclaredKind,
	type ExportSurface,
	linkModuleGraph,
	type LinkedGraph,
	type LinkedModule,
} from "./link"
export {
	canonicalPath,
	resolveSpecifier,
	type SpecifierRejection,
	type SpecifierResolution,
} from "./resolve"
