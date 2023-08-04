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

		static create (from eventDescription: String) -> Event {
			constant splitEvent = eventDescription::split(on ".")

			constant eventName = match splitEvent::first() {
				case String -> String {
					<- @
				}

				case Nothing -> String {
					<- ""
				}
			}
			constant namespaces = splitEvent::dropFirst()::unique()

			<- {
				eventName = eventName,
				namespaces = namespaces,
				isDefaultPrevented = false,
				isCancelled = false,
				isPropagationStopped = false,
			}
		}
	}

	variable event = Event.create(from "event.namespace")
	event = event::stopPropagation()

}
