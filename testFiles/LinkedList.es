type Nothing
end

type Just<T>
	value T
end

datatype Maybe<T>
	case Nothing
	case Just<T>
end

type Node<T>
	value T
	next Maybe<Self>

	concat (node Node) -> Self
		self.next = Just{ value = node }
	end

	disconnect () -> Self
		self.next = Nothing{}
	end

	getValueAt (index Integer) -> Maybe<T>
		let node = self
		let counter = 0

		while counter <= index
			counter++

			~ node.next as value
				case Nothing
					return Nothing{}
				end

				case Node
					node = value
				end
			end
		end

		return Just<T>{ value = node.value }
	end
end
