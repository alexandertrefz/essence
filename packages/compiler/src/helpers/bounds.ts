// NOTE: THE words for "a Type Parameter carries one bound", shared by the two
// Enricher reports that have to say it: two bounds written down in one `<…>`,
// and a body that wants a second Protocol of a Parameter something already
// bounded. A reader who meets the rule twice in two spellings has to work out
// whether it is one rule or two, and it is one.
//
// No Help goes with them, and that is deliberate. The combined Protocol named
// below is the only way to ask for two bounds today, and it is not an edit that
// works from where either report stands: it needs a declaration AND a
// conformance for every Type the Parameter is ever bound to, which for a Type
// the standard library owns is not the reader's to write — conforming `Integer`
// to it makes every `Terminal.print(5)` in the file ambiguous. So the rule is
// stated, the one way around it is named as what it is, and the reader chooses.
export function oneBoundOnly(
	parameter: string,
	carried: string,
	wanted: string,
): Array<string> {
	return [
		`'${parameter}' is bounded by '${carried}' already, and a Type Parameter carries ONE bound — a second would replace it rather than stand beside it.`,
		`A Protocol that extends both — 'protocol Ranked is ${carried}, is ${wanted} {}' — is how a Parameter asks for two, and only Types this Program can declare that conformance for can satisfy it.`,
	]
}
