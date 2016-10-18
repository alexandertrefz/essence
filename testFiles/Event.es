type Event {
	eventName String
	isDefaultPrevented Bool
	isCancelled Bool
	isPropagationStopped Bool

	preventDefault() -> Self {
		<- @ <| { isDefaultPrevented = true }
	}

	cancel() -> Self {
		<- @ <| { isCancelled = true }
	}

	stopPropagation() -> Self {
		<- @ <| { isPropagationStopped = true }
	}

	hasNamespaces() -> Bool {
		<- @eventName::contains('.')
	}

	getNamespaces() -> [String] {
		<- @eventName
			::split(' ')
			::map((event) -> event::split('.')::slice(1))
			::reduce((namespaces, eventNames) -> namespaces::join(eventNames), [])
			::unique()
	}

	hasEventName() -> Bool {
		<- @::getEventName() != ''
	}

	getEventName() -> String {
		<- @eventName::split('.')::first()
	}
}
