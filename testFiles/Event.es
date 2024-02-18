implementation {

	type Event {
		eventName:            String
		namespaces:           [String]
		isDefaultPrevented:   Boolean
		isCancelled:          Boolean
		isPropagationStopped: Boolean

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

		static createFrom (_ eventDescription: String) -> Event {
			constant splitEvent = eventDescription::splitOn(".")

			constant eventName = match splitEvent::firstItem() {
				case Nothing -> String { <- "" }
				case String  -> String { <- @ }
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

	variable event = Event.createFrom("event.namespace")
	event = event::stopPropagation()

	§ This will not be true, because we changed the `event` object above
	if event::is(Event.createFrom("event.namespace")) {
		__print("The Records are the same!")
	}

}
