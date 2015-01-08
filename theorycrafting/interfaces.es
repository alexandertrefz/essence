// BuiltIn
interface IObject {

}

interface ICallable extends IObject {
    __call__(self, ...args):any
}

// primitive-literals



// STDLib

// Not specifying a type defaults to IObject
interface IEventable extends IObject {
    on(event, handler(event)):void
    off(event, ?handler(event)):void
    trigger(event):void
}

