type Event {
	eventName:            String
	namespaces:           [String]
	isDefaultPrevented:   Boolean
	isCancelled:          Boolean
	isPropagationStopped: Boolean

	preventDefault () -> Event {
		<- @ <| { isDefaultPrevented = true }
	}

	cancel () -> Event {
		<- @ <| { isCancelled = true }
	}

	stopPropagation () -> Event {
		<- @ <| { isPropagationStopped = true }
	}

	hasNamespaces () -> Boolean {
		<- @.namespaces::hasItems()
	}

	static create (from eventDescription: String) -> Event {
		constant splitEvent = eventDescription::split(on ".")

		constant eventName = splitEvent::first()
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

constant event = Event.create(from "event.namespace")
__print(event)
