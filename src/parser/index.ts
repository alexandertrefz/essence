// NOTE: The recursive descent parser in ./descent is the default parser.
// `parseWithDiagnostics` reports syntax errors as Diagnostics and always
// produces a Program — it is the form the compiler driver uses to gate
// compilation. `parse` is the convenience form for callers that only need
// the AST.
export {
	type ParseResult,
	type ParserOptions,
	parse,
	parseWithDiagnostics,
} from "./descent/index"
