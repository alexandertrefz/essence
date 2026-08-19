§ Deliberately broken: dotted keys the Parser itself turns away — one written
§ with no value at all, and two that write the same member twice.

implementation {
	type Tls = { enabled: Boolean }
	type Server = { host: String, port: Integer, tls: Tls }
	type Config = { name: String, server: Server }

	constant config: Config = {
		name = "api",
		server = { host = "localhost", port = 80, tls = { enabled = false } },
	}
	constant port = 8080

	§ A path names a member of a value one step in, and a local beside it.
	§ Nothing says the two are the same thing, so a path always spells its
	§ value.
	constant bare = { config with server.port, name = "api" }

	§ A key that sets the whole Record and a path that reaches into it both
	§ write `server`, and only one of them can survive.
	constant clashing = {
		config with
			server = { host = "db", port = 5432, tls = { enabled = true } },
			server.port = port,
	}

	§ A descend with nothing in it says to leave `server` exactly as it was,
	§ which is a half-written key rather than an intent.
	constant blank = { config with server.{} }
}
