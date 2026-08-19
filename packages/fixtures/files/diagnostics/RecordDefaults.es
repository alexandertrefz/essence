§ Deliberately broken: what the Validator says about an Argument written for a
§ Record Parameter whose default fills only some of its members in — and about
§ the payload of a Case whose default does the same.

implementation {
	type Options = { host: String, retries: Integer, tls: Boolean }

	§ A partial default says which members a call may leave out of the Record
	§ it writes; every other member still has to be written.
	function connect(_ url: String, using options: Options = { retries = 3 }) -> String {
		<- url
	}

	Terminal.print(connect("essence.lang", using { retries = 1 }))

	§ A member with the wrong Type is not a partial of the Parameter at all, so
	§ the Argument is measured whole and named whole.
	Terminal.print(connect("essence.lang", using { host = 1, tls = true }))

	§ And so is a member the Parameter's Type does not declare.
	Terminal.print(
		connect("essence.lang", using { host = "h", tls = true, timeout = 30 }),
	)

	§ Only an Argument WRITTEN as a Record literal may leave a member out. Any
	§ other Record carries whatever its value holds — width subtyping admits a
	§ value with more members than its Type names — and the members the callee
	§ fills in are exactly the ones it would read off it.
	constant partial: { host: String, tls: Boolean } = {
		host = "h",
		tls = true,
		retries = 1,
	}

	Terminal.print(connect("essence.lang", using partial))

	§ A Case payload's default says the same thing about a construction: the
	§ members it fills in are the ones a payload may leave out, and every other
	§ one still has to be written.
	choice Fetch {
		Get { url: String, retries: Integer } = { retries = 0 },
		Blank { tags: List<String>, title: String } = { tags = [], title = "" },
	}

	constant incomplete: Fetch = #Get({})

	§ A bare Case name is a UNIT Case's spelling and stays one, however much of
	§ a payload is defaulted — so a Case that fills every member in is still
	§ constructed with a payload, and the empty Record is what to write.
	constant bare: Fetch = #Blank
}
