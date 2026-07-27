// NOTE: One stage, one entry in the Compiler's exports map — `@essence/cli` and
// `@essence/language-server` both load a graph, and neither should have to know
// which of the three files inside this directory holds which half of the answer.
export { loadModuleGraph, type Module, type ModuleGraph } from "./graph"
export { diskModuleHost, type ModuleHost } from "./host"
export {
	canonicalPath,
	resolveSpecifier,
	type SpecifierRejection,
	type SpecifierResolution,
} from "./resolve"
