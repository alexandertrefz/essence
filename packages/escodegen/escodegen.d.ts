// NOTE: Hand-written declarations for the vendored fork — upstream never
// shipped any, and `@types/escodegen` types a package named `escodegen`, not
// this one. They cover upstream's documented option surface; the shape the
// undocumented `sourceMapWithCode` mode answers with is asserted at the
// compiler's one call site instead (see `generateProgram` in
// `packages/compiler/src/rewriter/index.ts`).

export interface IndentOptions {
	style?: string
	base?: number
	adjustMultilineComment?: boolean
}

export interface FormatOptions {
	indent?: IndentOptions
	newline?: string
	space?: string
	json?: boolean
	renumber?: boolean
	hexadecimal?: boolean
	quotes?: string
	escapeless?: boolean
	compact?: boolean
	parentheses?: boolean
	semicolons?: boolean
	safeConcatenation?: boolean
	preserveBlankLines?: boolean
}

export interface GenerateOptions {
	format?: FormatOptions
	comment?: boolean
	directive?: boolean
	file?: string
	moz?: {
		starlessGenerator?: boolean
		parenthesizedComprehensionBlock?: boolean
		comprehensionExpressionStartsWithAssignment?: boolean
	}
	parse?: (code: string) => unknown
	sourceMap?: string | boolean
	sourceMapRoot?: string
	sourceMapWithCode?: boolean
	sourceContent?: string
	verbatim?: string
}

export function generate(node: object, options?: GenerateOptions): string

export function attachComments(
	tree: object,
	providedComments: Array<object>,
	tokens: Array<object>,
): object

export const Precedence: Record<string, number>
export const version: string
export const browser: boolean
export const FORMAT_MINIFY: FormatOptions
export const FORMAT_DEFAULTS: FormatOptions
