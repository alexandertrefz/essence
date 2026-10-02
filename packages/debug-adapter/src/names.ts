// The compiler's naming read backwards: what a JavaScript frame or binding is
// called in Essence. Each rule mirrors an injective one of the Rewriter, so
// reading it back is exact.
//
// - `$user_` mangling keeps `[A-Za-z0-9$]` and writes any other character as
//   `_<hex>_`. No Essence identifier holds a `_`, which lexes as a Symbol.
// - A reserved word is prefixed with `_`, and an overload ends `__overload$N`.
// - A standard library Method is `$es_<Namespace>_<member>`.
// - A Protocol's provided Method is `$es_<Protocol>__<member>` or
//   `$es_<Protocol>_<n>__<member>`.

import { isSynthesizedName } from "@essence-lang/compiler/helpers"
import {
	mangledNamePrefix,
	reservedJavaScriptWords,
} from "@essence-lang/compiler/rewriter/names"

const stdlibMethodPrefix = "$es_"
// The Constant a `require` holds its subject in, as the Enricher names it.
const requireSubjectPrefix = "$assertion_"
const overloadSuffix = /__overload\$\d+$/
const providedMethod = /^([^_]+)(?:_\d+)?__(.+)$/

function demangleUserName(mangled: string): string {
	return mangled
		.slice(mangledNamePrefix.length)
		.replace(/_([0-9a-f]+)_/g, (_, hex: string) =>
			String.fromCodePoint(Number.parseInt(hex, 16)),
		)
}

// One emitted name as the author spelled it. The overload suffix is appended
// to an escaped name, so it comes off first.
export function demangleName(name: string): string {
	let base = name.replace(overloadSuffix, "")

	if (base.startsWith(stdlibMethodPrefix)) {
		let rest = base.slice(stdlibMethodPrefix.length)
		let provided = providedMethod.exec(rest)

		if (provided !== null) {
			return `${provided[1]}.${provided[2]}`
		}

		let separator = rest.indexOf("_")

		if (separator > 0) {
			return `${rest.slice(0, separator)}.${rest.slice(separator + 1)}`
		}

		return rest
	}

	if (base.startsWith(mangledNamePrefix)) {
		return demangleUserName(base)
	}

	// A `_new` in a frame is the user's `new`, while `_self` is the compiler's
	// receiver.
	if (base.startsWith("_") && reservedJavaScriptWords.has(base.slice(1))) {
		return base.slice(1)
	}

	return base
}

// Whether the Lexer reads `text` as one word, such as `ok?`, `new` or
// `with`: no whitespace, Symbol or sigil in it, and no leading digit.
const singleWord =
	/^[^0-9 \t\r\n\uFEFF"§(){}[\]<>|/@,.:=\-~_#][^ \t\r\n\uFEFF"§(){}[\]<>|/@,.:=\-~_#]*$/

export function isSingleWord(text: string): boolean {
	return singleWord.test(text)
}

// Whether a binding is the compiler's own rather than the author's, which the
// Variables view leaves out of a scope.
export function isCompilerBinding(name: string): boolean {
	return (
		name === "$type" ||
		name === "$helpers" ||
		name === "$_" ||
		// A binding the Enricher named, such as the one a Pattern reads its
		// members off, `$pattern_6_12`. The names the Pattern binds are the
		// author's and stay. A `require` subject stays too, since no other
		// binding holds that value.
		(isSynthesizedName(name) && !name.startsWith(requireSubjectPrefix)) ||
		name.startsWith(stdlibMethodPrefix) ||
		name.endsWith("__conformance")
	)
}
