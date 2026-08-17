implementation {

	§ A browser-style event, modelled as a Record with a Namespace working on
	§ it. Every Method answers a copy with one field changed — `{ @ with … }` —
	§ so handling an event never changes the event another handler already saw.

	type Event = {
		eventName: String,
		namespaces: List<String>,
		isDefaultPrevented: Boolean,
		isCancelled: Boolean,
		isPropagationStopped: Boolean,
	}

	namespace Event for Event {
		preventDefault() -> Event {
			<- { @ with isDefaultPrevented = true }
		}

		cancel() -> Event {
			<- { @ with isCancelled = true }
		}

		stopPropagation() -> Event {
			<- { @ with isPropagationStopped = true }
		}

		hasNamespaces() -> Boolean {
			<- @.namespaces::hasItems()
		}

		§ The Overloads share a name and differ by their Parameters — no
		§ Arguments for the blank event, a description to parse otherwise.
		overload static createFrom {
			() -> Event {
				<- {
					eventName = "",
					namespaces = [],
					isDefaultPrevented = false,
					isCancelled = false,
					isPropagationStopped = false,
				}
			}

			§ "click.menu.navigation" names the event and its namespaces, the
			§ way jQuery spells them; a namespace listed twice counts once.
			(_ eventDescription: String) -> Event {
				constant splitEvent = eventDescription::split(on ".")

				constant eventName = splitEvent
					::firstItem()
					::value(withDefault "")

				constant namespaces = splitEvent
					::removeFirst()
					::removeDuplicates()

				<- {
					eventName = eventName,
					namespaces = namespaces,
					isDefaultPrevented = false,
					isCancelled = false,
					isPropagationStopped = false,
				}
			}
		}
	}

	constant clicked = Event.createFrom("click.menu.navigation.menu")

	Terminal.inspect(clicked.eventName) § "click"
	Terminal.inspect(clicked.namespaces) § [ "menu", "navigation" ] — the repeat dropped
	Terminal.inspect(clicked::hasNamespaces()) § true
	Terminal.inspect(Event.createFrom()::hasNamespaces()) § false — the blank event

	§ Records compare structurally — parsing the same description twice gives
	§ the same Event, and `is` says so.
	Terminal.inspect(
		clicked::is(Event.createFrom("click.menu.navigation.menu")),
	) § true

	§ A handler marks the event handled; the copies chain, the original stays.
	constant handled = clicked::preventDefault()::stopPropagation()

	Terminal.inspect(handled.isDefaultPrevented) § true
	Terminal.inspect(handled.isPropagationStopped) § true
	Terminal.inspect(clicked.isPropagationStopped) § false — untouched
	Terminal.inspect(handled::isNot(clicked)) § true
}
