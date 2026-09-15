§ Parameters a call may leave out — what the `.d.ts` says about them, and what
§ the marshaller accepts.

implementation {

	§ A trailing default, which the positional declaration may mark `?`.
	function scaled(_ value: Integer, by factor: Integer = 2) -> Integer {
		<- value::multiply(with factor)
	}

	§ A default with a REQUIRED Parameter after it — legal in Essence, because
	§ the labels tell the two apart, and not legal as `a?: T, b: U` in
	§ TypeScript. The positional declaration keeps it required and widens it;
	§ only the labelled form marks it optional.
	function cut(from start: Integer = 0, to end: Integer) -> Integer {
		<- end::subtract(start)
	}

	§ Every Parameter defaulted, so a call may write nothing at all.
	function greeting(
		with prefix: String = "hello",
		and name: String = "world",
	) -> String {
		<- "{prefix} {name}"
	}

	type Options = { host: String, retries: Integer, secure: Boolean }

	§ A PARTIAL Record default. The Argument is still required — the members
	§ the default does not fill in have to be written — but `retries` may be
	§ left out of it, which is what the declaration marks `?`.
	function connect(
		_ url: String,
		using options: Options = { retries = 3 },
	) -> String {
		<- "{url}|{options.host}|{options.retries}|{options.secure}"
	}

	§ A unit Choice, so that a Case value standing as a payload default's member
	§ crosses as a bare string on the way back out.
	choice Method {
		Verbose,
		Quiet,
	}

	§ A default value that NAMES a Constant, through a second Constant on the
	§ way. Nothing is spliced: the value is read once, where the Choice is
	§ declared, and baked into the Case Type as data — so it reaches the
	§ boundary the way a written literal does.
	constant standardHeader = "Accept"
	constant standardHeaders: List<String> = [standardHeader]

	§ A Case whose payload shape carries a default. Unlike a Record Parameter's
	§ there is no callee to fill it in at — a Case is built where it is written,
	§ and a host writing one is where it is written — so the boundary itself
	§ fills the members a host left out, out of the values the Case declared.
	choice Fetch {
		Get {
			url: String,
			retries: Integer,
			tags: List<String>,
			headers: List<String>,
			limits: { calls: Integer },
			mode: Method,
		} = {
			retries = 0,
			tags = [],
			headers = standardHeaders,
			limits = { calls = 10 },
			mode = #Quiet,
		},
		Ping,
	}

	function spelled(_ mode: Method) -> String {
		<- match mode -> String {
			case #Verbose { <- "loud" }
			case #Quiet   { <- "quiet" }
		}
	}

	function fetched(_ request: Fetch) -> String {
		<- match request -> String {
			case #Get({ url, retries, tags, headers, limits, mode }) {
				<- "{url}|{retries}|{tags::length()}|{headers::join(with ",")}|{
					limits.calls
				}|{spelled(mode)}"
			}
			case #Ping                                               {
				<- "ping"
			}
		}
	}

	§ The same Case coming back OUT, which always carries every member.
	function blank() -> Fetch {
		<- #Get({ url = "/" })
	}
}

export {
	Fetch
	Method
	blank
	connect
	cut
	fetched
	greeting
	scaled
}
