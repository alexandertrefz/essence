§ Deliberately broken: a dotted key written where there is no value under it to
§ reach into — a Record Literal writes its members from nothing.

implementation {
	type Tls = { enabled: Boolean }
	type Server = { host: String, port: Integer, tls: Tls }
	type Config = { name: String, server: Server }

	§ A plain Literal, where a path names a member of a value that does not
	§ exist yet.
	constant config: Config = {
		name = "api",
		server.port = 8080,
	}
}
