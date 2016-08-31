import {
	IValueNode,
} from '../Interfaces'

import { generateValueNode } from './helpers'

export let negate = (self: IValueNode) => {
	return generateValueNode('Bool', !self.value, {})
}

export let equals = (self: IValueNode, other: IValueNode) => {
	return generateValueNode('Bool', self.value === other.value, {})
}
