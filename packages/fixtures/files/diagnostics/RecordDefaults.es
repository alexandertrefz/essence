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
}
