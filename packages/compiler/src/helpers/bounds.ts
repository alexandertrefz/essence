// The notes for "a Type Parameter carries one bound". The Enricher reports two
// bounds in one `<…>`, and a second Protocol wanted of a bounded Parameter, with
// these words.
//
// A Protocol that extends both is named in a note, not offered as a Help. It
// needs a conformance for every Type bound to the Parameter, and a standard
// library Type's conformance is not the reader's to write.
export function oneBoundOnly(
	parameter: string,
	carried: string,
	wanted: string,
): Array<string> {
	// Two Protocols spelled alike here can not both be written in one
	// clause, so the example is left out.
	let example =
		carried === wanted
			? ""
			: ` — 'protocol Ranked is ${carried}, is ${wanted} {}' —`

	return [
		`'${parameter}' is bounded by '${carried}' already, and a Type Parameter carries ONE bound — a second would replace it rather than stand beside it.`,
		`A Protocol that extends both${example} is how a Parameter asks for two, and only Types this Program can declare that conformance for can satisfy it.`,
	]
}
