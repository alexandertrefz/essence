// The recursive descent parser in ./descent is the compiler's parser.
// `parseWithDiagnostics` reports syntax errors as Diagnostics and always
// produces a Program. `parse` is the form for callers that only need the AST.
export { documentationPrefix } from "./documentation"
export {
	type ParseResult,
	type ParserOptions,
	parse,
	parseWithDiagnostics,
} from "./descent/parse"
