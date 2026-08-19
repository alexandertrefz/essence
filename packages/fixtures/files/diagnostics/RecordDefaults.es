§ Deliberately broken: what the Validator says about an Argument written for a
§ Record Parameter whose default fills only some of its members in.

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
}
