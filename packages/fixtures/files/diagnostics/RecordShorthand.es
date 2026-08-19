§ Deliberately broken: a bare member name written where an update's key list
§ stands, which is the one set of braces the Record shorthand does not reach.

implementation {
	type Server = { host: String, port: Integer }

	constant host = "localhost"
	constant port = 8080

	§ A Record Literal reads a bare name as the member AND its value.
	constant server: Server = { host, port }

	§ An update's key list does not: a bare name after `with` is already the
	§ whole value being merged in, so `{ server with port }` would mean
	§ something else entirely.
	constant moved = { server with host, port }
}
