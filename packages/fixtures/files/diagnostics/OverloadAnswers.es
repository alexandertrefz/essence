§ An Overload whose entries differ only in what a callback answers is told
§ apart by the callback's body, where the callback writes no '-> Type'. Each
§ entry below takes an Integer, so a body answering one leaves the call two
§ entries it could mean.
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/OverloadAnswers.es
§
§ Keep both entries taking an Integer. If one of them stops, the call reads
§ one way only, and the Diagnostic it showcases no longer has a home.

implementation {
	namespace Picks for Integer {
		overload static pick {
			(on key: (_ v: Integer) -> Integer | String) -> String {
				<- "text"
			}

			(on key: (_ v: Integer) -> Integer | Boolean) -> String {
				<- "flag"
			}
		}
	}

	§ ambiguous-overload-answer — the body answers an Integer, which both
	§ entries take, and neither entry takes what the other one answers.
	constant picked = Picks.pick(on (v) { <- v })

	§ The spellings that read one way, and so say nothing here: a body
	§ answering what one entry alone takes, and a written answer Type.
	constant texted  = Picks.pick(on (v) { <- "s" })
	constant flagged = Picks.pick(on (v) -> Integer | Boolean { <- v })
}
