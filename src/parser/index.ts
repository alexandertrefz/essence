import grammar from "./grammar";
import { Parser, Grammar } from "nearley";

class ParseError extends Error {
	constructor(public message: string) {
		super(message);
		Error.captureStackTrace(this, ParseError);
		this.name = this.constructor.name;
	}
}

export let parse = (chunk: string) => {
	let parser = new Parser(Grammar.fromCompiled(grammar));

	try {
		parser.feed(chunk);
	} catch (error: any) {
		/* istanbul ignore next */
		let value = error.token.value;

		/* istanbul ignore if */
		if (error.token.type === "LiteralString") {
			value = `"${value}"`;
		}

		throw new ParseError(
			`Unexpected ${value} at ${error.token.position.start.line}:${error.token.position.start.column}`,
		);
	}

	/* istanbul ignore if */
	if (parser.results.length === 0) {
		throw new Error("Could not parse input!");
	}

	/* istanbul ignore if */
	// This should never occur, it is simply kept for accelerated triage of bugs.
	if (parser.results.length > 1) {
		/* Simple Debug
		console.log()
		console.log('Total amount of results:', parser.results.length)
		console.log()
		console.log('First Result:')
		console.log('=============')
		console.dir(parser.results[0], { depth: null })
		console.log()
		console.log()
		console.log('Second Result:')
		console.log('==============')
		console.dir(parser.results[1], { depth: null })
		console.log()
		//*/

		throw new Error("Input was ambiguous! - File a bug!");
	}

	return parser.results[0];
};
