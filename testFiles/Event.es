implementation {

	type Event = {
		eventName:            String,
		namespaces:           List<String>,
		isDefaultPrevented:   Boolean,
		isCancelled:          Boolean,
		isPropagationStopped: Boolean,
	}

	namespace Event for Event {
		preventDefault () -> Event {
			<- { @ with isDefaultPrevented = true }
		}

		cancel () -> Event {
			<- { @ with isCancelled = true }
		}

		stopPropagation () -> Event {
			<- { @ with isPropagationStopped = true }
		}

		hasNamespaces () -> Boolean {
			<- @.namespaces::hasItems()
		}

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

			(_ eventDescription: String) -> Event {
				constant splitEvent = eventDescription::splitOn(".")

				constant eventName = match splitEvent::firstItem() -> String {
					case Nothing { <- "" }
					case String  { <- @ }
				}

				constant namespaces = splitEvent::removeFirst()::removeDuplicates()

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

	variable event = Event.createFrom("event.namespace")

	if event::is(Event.createFrom("event.namespace")) {
		__print("The Records are the same!")
	}

	event = event::stopPropagation()

	if event::isNot(Event.createFrom("event.namespace")) {
		__print("The Records are not the same anymore!")
	}
}
