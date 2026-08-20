§ Deliberately broken: dotted keys written where a Literal IS merged into a
§ default — an Argument and a Case payload — reaching into members that default
§ does not merge into.

implementation {
	type Server = { host: String, port: Integer }
	type Options = { retries: Integer, server: Server }

	constant fallback: Server = { host = "localhost", port = 8080 }

	§§ Answers a description of the connection.
	§§
	§§ @param _ — the address to connect to.
	§§ @param using — how to connect.
	§§ @returns — the description.
	function connect(_ url: String, using options: Options = { retries = 3 }) -> String {
		<- url
	}

	§§ Answers a description of the connection, with a whole Server behind it.
	§§
	§§ @param _ — the address to connect to.
	§§ @param using — how to connect.
	§§ @returns — the description.
	function reach(
		_ url: String,
		using options: Options = { retries = 3, server = fallback },
	) -> String {
		<- url
	}

	§ This default fills in `retries` alone, so there is no `server` under the
	§ key to merge with — every call writes that member for itself.
	Terminal.print(connect("essence.lang", using { server.port = 1 }))

	§ This one does fill `server` in, but NAMES a value for it rather than
	§ writing its members out, so the member is filled in whole or not at all.
	Terminal.print(reach("essence.lang", using { server.port = 1 }))

	§ Every step but the last names the value the step after it reaches into,
	§ and a String has no members to reach.
	Terminal.print(
		reach("essence.lang", using { retries.length = 1, server = fallback }),
	)

	§ A Case payload is merged into its own default and reads the same way: this
	§ default fills in `limits`, and nothing fills in `origin`.
	choice Fetch {
		Get { origin: Server, limits: Server } = {
			limits = { host = "h", port = 1 },
		},
	}

	constant reaching: Fetch = #Get({ origin.port = 3, limits.port = 2 })
}
