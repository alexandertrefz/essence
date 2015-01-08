interface IIterable {
    __iterate__:
}

trait TArray implements IIterable {

}

interface IEquatable<Generic> {
    equals(item:Generic)
}

// Extends IObject interface
interface IEventable extends IObject {
    on(event, handler(event)):void
    off(event, ?handler(event)):void
    trigger(event):void
}

class EventMachine implements IEventable {

}


// Extends class EventMachine and trait TArray and implements interface IEquatable for type Object
// by extending EventMachine it implements IEventable
// by extending TArray it implements IIterable
class ArrayLike extends TArray, EventMachine implements IEquatable<Object> {
    equals(obj:Object) {
        return Object.hasInterface(IIterable)
    }

}