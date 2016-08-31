import {
	IValueNode,
} from '../Interfaces'

import { generateValueNode } from './helpers'

export let equals = (self: IValueNode, other: IValueNode) => {
	return generateValueNode('Bool', self.value === other.value, {})
}

export let join = (self: IValueNode, other: IValueNode) => {
	return generateValueNode('String', self.value + other.value, {})
}
