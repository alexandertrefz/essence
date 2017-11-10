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
		constant dotOrColon = [".", ":"]
		constant splitEvent = eventDescription::split(on dotOrColon)

		constant eventName = splitEvent::first()
		constant namespaces = splitEvent::dropFirst()::unique()

		<- {
			eventName = eventName,
			namespaces = namespaces,
		}
	}
}

constant event = Event.create("event.namespace")
