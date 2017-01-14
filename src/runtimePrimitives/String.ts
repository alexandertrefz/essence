import { parser } from '../interfaces'

type IValueNode = parser.IValueNode

import { generateValueNode } from './helpers'

export let equals = (self: IValueNode, other: IValueNode) => {
	return generateValueNode('Bool', self.value === other.value, {})
}

export let contains = (self: IValueNode, other: IValueNode) => {
	return generateValueNode('Bool', (self.value as string).includes(other.value as string), {})
}

export let join = (self: IValueNode, other: IValueNode) => {
	return generateValueNode('String', (self.value as string) + (other.value as string), {})
}
