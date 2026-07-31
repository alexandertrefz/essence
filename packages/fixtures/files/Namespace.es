implementation {

	§ A Namespace packs Methods for a Type it does not own. These two hold two
	§ readings of one and the same Integer — a count of seconds as a length of
	§ time, and as a position on the wall clock. The receiver's Type and the
	§ Arguments pick the Namespace for a call; where several would fit,
	§ `::<Namespace>` names the one that is meant.

	namespace Duration for Integer {
		hours() -> Integer {
			<- @::quotient(dividingBy 3600)
		}

		minutes() -> Integer {
			<- @::remainder(dividingBy 3600)::quotient(dividingBy 60)
		}

		seconds() -> Integer {
			<- @::remainder(dividingBy 60)
		}

		formatted() -> String {
			<- "{@::hours()}h {@::minutes()}m {@::seconds()}s"
		}
	}

	namespace Clock for Integer {
		§ A Namespace can carry values of its own — `noon` belongs to Clock,
		§ not to any particular Integer.
		static noon = 43_200

		formatted() -> String {
			<- "{@::hours()::padded()}:{@::minutes()::padded()}:{
				@::seconds()::padded()
			}"
		}

		padded() -> String {
			<- @::toString()::pad(to 2, with "0")
		}
	}

	§ A Namespace targets structural Record Types just as well — any Record
	§ with these two fields answers `duration`, whoever declared it.
	namespace Schedule for { departure: Integer, arrival: Integer } {
		duration() -> Integer {
			<- @.arrival::subtract(@.departure)
		}
	}

	constant flight = { departure = 41_400, arrival = 45_072 }

	§ Only Duration declares `hours`, so the bare call finds it.
	__print(flight::duration()) § 3672
	__print(flight::duration()::hours()) § 1

	§ Both declare `formatted`, so the call says which reading it wants.
	__print(flight::duration()::<Duration>formatted()) § "1h 1m 12s"
	__print(flight::duration()::<Clock>formatted()) § "01:01:12"

	__print(Clock.noon::<Clock>formatted()) § "12:00:00"
	__print(
		flight.arrival::isGreaterThan(Clock.noon),
	) § true — landing after noon
}
