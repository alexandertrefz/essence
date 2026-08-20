§ A Record two levels deep, updated through dotted keys. A path key is a nested
§ update the Compiler writes out: `{ config with server.port = 8080 }` IS
§ `{ config with server = { config.server with port = 8080 } }`, so a key that
§ names a whole member REPLACES it and a path that reaches into one MERGES —
§ and a Type may grow a member without either of them changing meaning.

implementation {
	type Tls = { enabled: Boolean, authority: String }
	type Server = { host: String, port: Integer, tls: Tls }
	type Config = { name: String, retries: Integer, server: Server }

	constant config: Config = {
		name = "api",
		retries = 3,
		server = {
			host = "localhost",
			port = 80,
			tls = { enabled = false, authority = "self" },
		},
	}

	§ One level in.
	constant moved = { config with server.port = 8080 }

	§ Two levels in, and a second key beside it that shares the first step —
	§ both reach through ONE `config.server`.
	constant secured = {
		config with
			server.tls.enabled = true,
			server.tls.authority = "letsencrypt",
			server.host = "api.example.com",
	}

	§ A path key beside a plain one.
	constant renamed = { config with name = "gateway", server.port = 443 }

	§ The whole member, which replaces rather than merges — the spelling a path
	§ key never turns into.
	constant blanked = {
		config with
			server = {
				host = "127.0.0.1",
				port = 1,
				tls = { enabled = false, authority = "none" },
			},
	}

	§ The braced descend, which writes a whole member list one level down. Its
	§ plain keys take the Record shorthand, because there is no `with` inside it
	§ for a bare name to be the whole value merged in.
	constant descended = { config with server.{ port = 8443, host = "api" } }

	§ A nested descend, and the shorthand a descend's plain keys may use.
	constant port     = 4433
	constant borrowed = { config with server.{ tls.{ enabled = true }, port } }

	§ A descend beside a plain key, and a path that reaches past one.
	constant both = {
		config with
			name = "edge",
			server.{ port = port, tls.authority = "internal" },
	}

	§ The other two Literals a path key reaches into are an ARGUMENT written for
	§ a defaulted Record Parameter and the payload of a defaulting Case. Both are
	§ merged into a default rather than into a value written beside them, and a
	§ path key means the same thing in all three: `server = { … }` replaces and
	§ `server.port = …` merges.

	§§ Answers the address a Config listens on.
	§§
	§§ @param using — how to listen.
	§§ @returns — the address.
	function listen(
		using settings: Config = {
			name = "api",
			retries = 1,
			server = {
				host = "localhost",
				port = 80,
				tls = { enabled = false, authority = "self" },
			},
		},
	) -> String {
		<- "{settings.server.host}:{settings.server.port} {settings.name}"
	}

	constant listening = listen(using { server.port = 8443 })
	constant relisted  = listen(using {
		name = "edge",
		server.{ host = "api.example.com", tls.authority = "internal" },
	})

	choice Endpoint {
		Bound { label: String, server: Server } = {
			server = {
				host = "0.0.0.0",
				port = 443,
				tls = { enabled = true, authority = "letsencrypt" },
			},
		},
	}

	constant bound: Endpoint = #Bound({ label = "public", server.port = 8080 })

	namespace Configs for Config {
		§§ Answers this Config listening on another port.
		§§
		§§ @param port — the port to listen on.
		§§ @returns — the moved Config.
		movedTo(_ port: Integer) -> Config {
			<- { @ with server.port = port }
		}
	}

	Terminal.inspect(moved.server.port)
	Terminal.inspect(secured.server.tls.authority)
	Terminal.inspect(secured.server.host)
	Terminal.inspect(renamed.name)
	Terminal.inspect(renamed.server.port)
	Terminal.inspect(blanked.server.tls.authority)
	Terminal.inspect(config::movedTo(9000).server.port)
	Terminal.inspect(descended.server.host)
	Terminal.inspect(borrowed.server.tls.enabled)
	Terminal.inspect(borrowed.server.port)
	Terminal.inspect(both.name)
	Terminal.inspect(both.server.tls.authority)

	Terminal.inspect(listening)
	Terminal.inspect(relisted)
	Terminal.inspect(bound)

	§ The value updated is never touched.
	Terminal.inspect(config.server.port)
	Terminal.inspect(config.server.tls.enabled)
}
