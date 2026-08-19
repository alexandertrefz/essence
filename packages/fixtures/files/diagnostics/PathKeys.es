§ Deliberately broken: dotted keys that name no nested update — one written
§ where nothing is being updated at all, one stepping through a value that has
§ no members, and one on a value that is worked out on the spot.

implementation {
	type Tls = { enabled: Boolean }
	type Server = { host: String, port: Integer, tls: Tls }
	type Config = { name: String, server: Server }

	constant config: Config = {
		name = "api",
		server = { host = "localhost", port = 80, tls = { enabled = false } },
	}

	function load() -> Config {
		<- config
	}

	§ A plain Literal writes its members from nothing, so there is no `server`
	§ under this key to reach into.
	constant blank: Config = {
		name = "api",
		server.port = 8080,
	}

	§ Every step but the last names the value the step after it updates, and a
	§ String can not be updated.
	constant renamed = { config with name.length = 1 }

	§ A path reads the value once for each level it reaches through, so the
	§ value has to be one that reads the same every time.
	constant loaded = { load() with server.port = 8080 }
}
