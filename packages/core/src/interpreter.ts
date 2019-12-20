import {
  StateMachine,
  Event,
  EventObject,
  CancelAction,
  DefaultContext,
  ActionObject,
  StateSchema,
  ActivityActionObject,
  SpecialTargets,
  ActionTypes,
  InvokeDefinition,
  SendActionObject,
  ServiceConfig,
  InvokeCallback,
  DisposeActivityFunction,
  StateValue,
  InterpreterOptions,
  ActivityDefinition,
  SingleOrArray,
  Subscribable,
  DoneEvent,
  Unsubscribable,
  MachineOptions,
  ActionFunctionMap,
  SCXML,
  EventData,
  Observer,
  Spawnable
} from './types';
import { State, bindActionToState, isState } from './State';
import * as actionTypes from './actionTypes';
import { doneInvoke, error, getActionFunction, initEvent } from './actions';
import { IS_PRODUCTION } from './environment';
import {
  isPromiseLike,
  mapContext,
  warn,
  keys,
  isArray,
  isFunction,
  isString,
  isObservable,
  uniqueId,
  isMachine,
  toEventObject,
  toSCXMLEvent,
  reportUnhandledExceptionOnInvocation,
  symbolObservable
} from './utils';
import { Scheduler } from './scheduler';
import { Actor, isActor } from './Actor';
import { isInFinalState } from './stateUtils';
import { registry } from './registry';
import { registerService } from './devTools';

export type StateListener<TContext, TEvent extends EventObject> = (
  state: State<TContext, TEvent>,
  event: TEvent
) => void;

export type ContextListener<TContext = DefaultContext> = (
  context: TContext,
  prevContext: TContext | undefined
) => void;

export type EventListener<TEvent extends EventObject = EventObject> = (
  event: TEvent
) => void;

export type Listener = () => void;

export interface Clock {
  setTimeout(fn: (...args: any[]) => void, timeout: number): any;
  clearTimeout(id: any): void;
}

interface SpawnOptions {
  name?: string;
  autoForward?: boolean;
  sync?: boolean;
}

const DEFAULT_SPAWN_OPTIONS = { sync: false, autoForward: false };

/**
 * Maintains a stack of the current service in scope.
 * This is used to provide the correct service to spawn().
 *
 * @private
 */
const withServiceScope = (() => {
  const serviceStack = [] as Array<Interpreter<any, any, any>>;

  return <T, TService extends Interpreter<any, any, any>>(
    service: TService | undefined,
    fn: (service: TService) => T
  ) => {
    service && serviceStack.push(service);

    const result = fn(
      service || (serviceStack[serviceStack.length - 1] as TService)
    );

    service && serviceStack.pop();

    return result;
  };
})();

enum InterpreterStatus {
  NotStarted,
  Running,
  Stopped
}

export class Interpreter<
  // tslint:disable-next-line:max-classes-per-file
  TContext,
  TStateSchema extends StateSchema = any,
  TEvent extends EventObject = EventObject
> implements Actor<State<TContext, TEvent>, TEvent> {
  /**
   * The default interpreter options:
   *
   * - `clock` uses the global `setTimeout` and `clearTimeout` functions
   * - `logger` uses the global `console.log()` method
   */
  public static defaultOptions: InterpreterOptions = (global => ({
    execute: true,
    deferEvents: true,
    clock: {
      setTimeout: (fn, ms) => {
        return setTimeout.call(null, fn, ms);
      },
      clearTimeout: id => {
        return clearTimeout.call(null, id);
      }
    },
    logger: console.log.bind(console),
    devTools: false
  }))(typeof window === 'undefined' ? global : window);
  /**
   * The current state of the interpreted machine.
   */
  private _state?: State<TContext, TEvent>;
  /**
   * The clock that is responsible for setting and clearing timeouts, such as delayed events and transitions.
   */
  public clock: Clock;
  public options: Readonly<InterpreterOptions>;

  private scheduler: Scheduler = new Scheduler();
  private delayedEventsMap: Record<string, number> = {};
  private listeners: Set<StateListener<TContext, TEvent>> = new Set();
  private contextListeners: Set<ContextListener<TContext>> = new Set();
  private stopListeners: Set<Listener> = new Set();
  private doneListeners: Set<EventListener> = new Set();
  private eventListeners: Set<EventListener> = new Set();
  private sendListeners: Set<EventListener> = new Set();
  private logger: (...args: any[]) => void;
  /**
   * Whether the service is started.
   */
  public initialized = false;
  private _status: InterpreterStatus = InterpreterStatus.NotStarted;

  // Actor
  public parent?: Interpreter<any>;
  public id: string;

  /**
   * The globally unique process ID for this invocation.
   */
  public sessionId: string;
  public children: Map<string | number, Actor> = new Map();
  private forwardTo: Set<string> = new Set();

  // Dev Tools
  private devTools?: any;

  /**
   * Creates a new Interpreter instance (i.e., service) for the given machine with the provided options, if any.
   *
   * @param machine The machine to be interpreted
   * @param options Interpreter options
   */
  constructor(
    public machine: StateMachine<TContext, TStateSchema, TEvent>,
    options: Partial<InterpreterOptions> = Interpreter.defaultOptions,
    sessionId?: string
  ) {
    const resolvedOptions: InterpreterOptions = {
      ...Interpreter.defaultOptions,
      ...options
    };

    const { clock, logger, parent, id } = resolvedOptions;

    const resolvedId = id !== undefined ? id : machine.id;

    this.id = resolvedId;
    this.logger = logger;
    this.clock = clock;
    this.parent = parent;

    this.options = resolvedOptions;

    this.scheduler = new Scheduler({
      deferEvents: this.options.deferEvents
    });

    this.sessionId =
      sessionId !== undefined ? sessionId : registry.register(this as Actor);
  }
  public get initialState(): State<TContext, TEvent> {
    return withServiceScope(this, () => this.machine.initialState);
  }
  public get state(): State<TContext, TEvent> {
    if (!IS_PRODUCTION) {
      warn(
        this._status !== InterpreterStatus.NotStarted,
        `Attempted to read state from uninitialized service '${this.id}'. Make sure the service is started first.`
      );
    }

    return this._state!;
  }
  public static interpret = interpret;
  /**
   * Executes the actions of the given state, with that state's `context` and `event`.
   *
   * @param state The state whose actions will be executed
   * @param actionsConfig The action implementations to use
   */
  public execute(
    state: State<TContext, TEvent>,
    actionsConfig?: MachineOptions<TContext, TEvent>['actions']
  ): void {
    for (const action of state.actions) {
      this.exec(action, state, actionsConfig);
    }
  }
  private update(
    state: State<TContext, TEvent>,
    _event: SCXML.Event<TEvent>
  ): void {
    // Attach session ID to state
    state._sessionid = this.sessionId;

    // Update state
    this._state = state;

    // Execute actions
    if (this.options.execute) {
      this.execute(this.state);
    }

    // Dev tools
    if (this.devTools) {
      this.devTools.send(_event.data, state);
    }

    // Execute listeners
    if (state.event) {
      for (const listener of this.eventListeners) {
        listener(state.event);
      }
    }

    for (const listener of this.listeners) {
      listener(state, state.event);
    }

    for (const contextListener of this.contextListeners) {
      contextListener(
        this.state.context,
        this.state.history ? this.state.history.context : undefined
      );
    }

    const isDone = isInFinalState(state.configuration || [], this.machine);

    if (this.state.configuration && isDone) {
      // get final child state node
      const finalChildStateNode = state.configuration.find(
        sn => sn.type === 'final' && sn.parent === this.machine
      );

      const doneData =
        finalChildStateNode && finalChildStateNode.data
          ? mapContext(finalChildStateNode.data, state.context, _event)
          : undefined;

      for (const listener of this.doneListeners) {
        listener(doneInvoke(this.id, doneData));
      }
      this.stop();
    }
  }
  /*
   * Adds a listener that is notified whenever a state transition happens. The listener is called with
   * the next state and the event object that caused the state transition.
   *
   * @param listener The state listener
   */
  public onTransition(
    listener: StateListener<TContext, TEvent>
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.listeners.add(listener);

    // Send current state to listener
    if (this._status === InterpreterStatus.Running) {
      listener(this.state, this.state.event);
    }

    return this;
  }
  public subscribe(observer: Observer<State<TContext, TEvent>>): Unsubscribable;
  public subscribe(
    nextListener?: (state: State<TContext, TEvent>) => void,
    // @ts-ignore
    errorListener?: (error: any) => void,
    completeListener?: () => void
  ): Unsubscribable;
  public subscribe(
    nextListenerOrObserver?:
      | ((state: State<TContext, TEvent>) => void)
      | Observer<State<TContext, TEvent>>,
    // @ts-ignore
    errorListener?: (error: any) => void,
    completeListener?: () => void
  ): Unsubscribable {
    if (!nextListenerOrObserver) {
      return { unsubscribe: () => void 0 };
    }

    let listener: (state: State<TContext, TEvent>) => void;
    let resolvedCompleteListener = completeListener;

    if (typeof nextListenerOrObserver === 'function') {
      listener = nextListenerOrObserver;
    } else {
      listener = nextListenerOrObserver.next.bind(nextListenerOrObserver);
      resolvedCompleteListener = nextListenerOrObserver.complete.bind(
        nextListenerOrObserver
      );
    }

    this.listeners.add(listener);

    // Send current state to listener
    if (this._status === InterpreterStatus.Running) {
      listener(this.state);
    }

    if (resolvedCompleteListener) {
      this.onDone(resolvedCompleteListener);
    }

    return {
      unsubscribe: () => {
        listener && this.listeners.delete(listener);
        resolvedCompleteListener &&
          this.doneListeners.delete(resolvedCompleteListener);
      }
    };
  }

  /**
   * Adds an event listener that is notified whenever an event is sent to the running interpreter.
   * @param listener The event listener
   */
  public onEvent(
    listener: EventListener
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.eventListeners.add(listener);
    return this;
  }
  /**
   * Adds an event listener that is notified whenever a `send` event occurs.
   * @param listener The event listener
   */
  public onSend(
    listener: EventListener
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.sendListeners.add(listener);
    return this;
  }
  /**
   * Adds a context listener that is notified whenever the state context changes.
   * @param listener The context listener
   */
  public onChange(
    listener: ContextListener<TContext>
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.contextListeners.add(listener);
    return this;
  }
  /**
   * Adds a listener that is notified when the machine is stopped.
   * @param listener The listener
   */
  public onStop(
    listener: Listener
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.stopListeners.add(listener);
    return this;
  }
  /**
   * Adds a state listener that is notified when the statechart has reached its final state.
   * @param listener The state listener
   */
  public onDone(
    listener: EventListener<DoneEvent>
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.doneListeners.add(listener);
    return this;
  }
  /**
   * Removes a listener.
   * @param listener The listener to remove
   */
  public off(
    listener: (...args: any[]) => void
  ): Interpreter<TContext, TStateSchema, TEvent> {
    this.listeners.delete(listener);
    this.eventListeners.delete(listener);
    this.sendListeners.delete(listener);
    this.stopListeners.delete(listener);
    this.doneListeners.delete(listener);
    this.contextListeners.delete(listener);
    return this;
  }
  /**
   * Alias for Interpreter.prototype.start
   */
  public init = this.start;
  /**
   * Starts the interpreter from the given state, or the initial state.
   * @param initialState The state to start the statechart from
   */
  public start(
    initialState?: State<TContext, TEvent> | StateValue
  ): Interpreter<TContext, TStateSchema, TEvent> {
    if (this._status === InterpreterStatus.Running) {
      // Do not restart the service if it is already started
      return this;
    }

    this.initialized = true;
    this._status = InterpreterStatus.Running;

    const resolvedState = withServiceScope(this, () => {
      return initialState === undefined
        ? this.machine.initialState
        : isState<TContext, TEvent>(initialState)
        ? this.machine.resolveState(initialState)
        : this.machine.resolveState(
            State.from(initialState, this.machine.context)
          );
    });

    if (this.options.devTools) {
      this.attachDev();
    }
    this.scheduler.initialize(() => {
      this.update(resolvedState, initEvent as SCXML.Event<TEvent>);
    });
    return this;
  }
  /**
   * Stops the interpreter and unsubscribe all listeners.
   *
   * This will also notify the `onStop` listeners.
   */
  public stop(): Interpreter<TContext, TStateSchema, TEvent> {
    for (const listener of this.listeners) {
      this.listeners.delete(listener);
    }
    for (const listener of this.stopListeners) {
      // call listener, then remove
      listener();
      this.stopListeners.delete(listener);
    }
    for (const listener of this.contextListeners) {
      this.contextListeners.delete(listener);
    }
    for (const listener of this.doneListeners) {
      this.doneListeners.delete(listener);
    }

    // Stop all children
    this.children.forEach(child => {
      if (isFunction(child.stop)) {
        child.stop();
      }
    });

    // Cancel all delayed events
    for (const key of keys(this.delayedEventsMap)) {
      this.clock.clearTimeout(this.delayedEventsMap[key]);
    }

    this.scheduler.clear();
    this.initialized = false;
    this._status = InterpreterStatus.Stopped;

    return this;
  }
  /**
   * Sends an event to the running interpreter to trigger a transition.
   *
   * An array of events (batched) can be sent as well, which will send all
   * batched events to the running interpreter. The listeners will be
   * notified only **once** when all events are processed.
   *
   * @param event The event(s) to send
   */
  public send = (
    event: SingleOrArray<Event<TEvent>> | SCXML.Event<TEvent>,
    payload?: EventData
  ): State<TContext, TEvent> => {
    if (isArray(event)) {
      this.batch(event);
      return this.state;
    }

    const _event = toSCXMLEvent(toEventObject(event as Event<TEvent>, payload));

    if (this._status === InterpreterStatus.Stopped) {
      // do nothing
      if (!IS_PRODUCTION) {
        warn(
          false,
          `Event "${_event.name}" was sent to stopped service "${
            this.machine.id
          }". This service has already reached its final state, and will not transition.\nEvent: ${JSON.stringify(
            _event.data
          )}`
        );
      }
      return this.state;
    }

    if (
      this._status === InterpreterStatus.NotStarted &&
      this.options.deferEvents
    ) {
      // tslint:disable-next-line:no-console
      if (!IS_PRODUCTION) {
        warn(
          false,
          `Event "${_event.name}" was sent to uninitialized service "${
            this.machine.id
          }" and is deferred. Make sure .start() is called for this service.\nEvent: ${JSON.stringify(
            _event.data
          )}`
        );
      }
    } else if (this._status !== InterpreterStatus.Running) {
      throw new Error(
        `Event "${_event.name}" was sent to uninitialized service "${
          this.machine.id
          // tslint:disable-next-line:max-line-length
        }". Make sure .start() is called for this service, or set { deferEvents: true } in the service options.\nEvent: ${JSON.stringify(
          _event.data
        )}`
      );
    }

    this.scheduler.schedule(() => {
      // Forward copy of event to child actors
      this.forward(_event);

      const nextState = this.nextState(_event);

      this.update(nextState, _event);
    });

    return this._state!; // TODO: deprecate (should return void)
    // tslint:disable-next-line:semicolon
  };

  private batch(events: Array<TEvent | TEvent['type']>): void {
    if (
      this._status === InterpreterStatus.NotStarted &&
      this.options.deferEvents
    ) {
      // tslint:disable-next-line:no-console
      if (!IS_PRODUCTION) {
        warn(
          false,
          `${events.length} event(s) were sent to uninitialized service "${
            this.machine.id
          }" and are deferred. Make sure .start() is called for this service.\nEvent: ${JSON.stringify(
            event
          )}`
        );
      }
    } else if (this._status !== InterpreterStatus.Running) {
      throw new Error(
        // tslint:disable-next-line:max-line-length
        `${events.length} event(s) were sent to uninitialized service "${this.machine.id}". Make sure .start() is called for this service, or set { deferEvents: true } in the service options.`
      );
    }

    this.scheduler.schedule(() => {
      let nextState = this.state;
      let batchChanged = false;
      let batchedActions: Array<ActionObject<TContext, TEvent>> = [];
      for (const event of events) {
        const _event = toSCXMLEvent(event);

        this.forward(_event);

        nextState = withServiceScope(this, () => {
          return this.machine.transition(nextState, _event);
        });

        batchedActions.push(
          ...(nextState.actions.map(a =>
            bindActionToState(a, nextState)
          ) as Array<ActionObject<TContext, TEvent>>)
        );

        batchChanged = batchChanged || !!nextState.changed;
      }

      nextState.changed = batchChanged;
      nextState.actions = batchedActions;
      this.update(nextState, toSCXMLEvent(events[events.length - 1]));
    });
  }

  /**
   * Returns a send function bound to this interpreter instance.
   *
   * @param event The event to be sent by the sender.
   */
  public sender(event: Event<TEvent>): () => State<TContext, TEvent> {
    return this.send.bind(this, event);
  }

  private sendTo = (
    event: SCXML.Event<TEvent>,
    to: string | number | Actor
  ) => {
    const isParent =
      this.parent && (to === SpecialTargets.Parent || this.parent.id === to);
    const target = isParent
      ? this.parent
      : isActor(to)
      ? to
      : this.children.get(to) || registry.get(to as string);

    if (!target) {
      if (!isParent) {
        throw new Error(
          `Unable to send event to child '${to}' from service '${this.id}'.`
        );
      }

      // tslint:disable-next-line:no-console
      if (!IS_PRODUCTION) {
        warn(
          false,
          `Service '${this.id}' has no parent: unable to send event ${event.type}`
        );
      }
      return;
    }

    if ('machine' in target) {
      // Send SCXML events to machines
      (target as Interpreter<TContext, TStateSchema, TEvent>).send({
        ...event,
        name:
          event.name === actionTypes.error ? `${error(this.id)}` : event.name,
        origin: this.sessionId
      });
    } else {
      // Send normal events to other targets
      target.send(event.data);
    }
  };
  /**
   * Returns the next state given the interpreter's current state and the event.
   *
   * This is a pure method that does _not_ update the interpreter's state.
   *
   * @param event The event to determine the next state
   */
  public nextState(
    event: Event<TEvent> | SCXML.Event<TEvent>
  ): State<TContext, TEvent> {
    const _event = toSCXMLEvent(event);

    if (
      _event.name.indexOf(actionTypes.errorPlatform) === 0 &&
      !this.state.nextEvents.some(
        nextEvent => nextEvent.indexOf(actionTypes.errorPlatform) === 0
      )
    ) {
      throw (_event.data as any).data;
    }

    const nextState = withServiceScope(this, () => {
      return this.machine.transition(this.state, _event);
    });

    return nextState;
  }
  private forward(event: SCXML.Event<TEvent>): void {
    for (const id of this.forwardTo) {
      const child = this.children.get(id);

      if (!child) {
        throw new Error(
          `Unable to forward event '${event}' from interpreter '${this.id}' to nonexistant child '${id}'.`
        );
      }

      child.send(event);
    }
  }
  private defer(sendAction: SendActionObject<TContext, TEvent>): void {
    this.delayedEventsMap[sendAction.id] = this.clock.setTimeout(
      () => {
        if (sendAction.to) {
          this.sendTo(sendAction._event, sendAction.to);
        } else {
          this.send(sendAction._event);
        }
      },
      sendAction.delay as number
    );
  }
  private cancel(sendId: string | number): void {
    this.clock.clearTimeout(this.delayedEventsMap[sendId]);
    delete this.delayedEventsMap[sendId];
  }
  private exec(
    action: ActionObject<TContext, TEvent>,
    state: State<TContext, TEvent>,
    actionFunctionMap?: ActionFunctionMap<TContext, TEvent>
  ): void {
    const { context, _event } = state;
    const actionOrExec =
      getActionFunction(action.type, actionFunctionMap) || action.exec;
    const exec = isFunction(actionOrExec)
      ? actionOrExec
      : actionOrExec
      ? actionOrExec.exec
      : action.exec;

    if (exec) {
      try {
        return exec(context, _event.data, {
          action,
          state: this.state,
          _event
        });
      } catch (err) {
        if (this.parent) {
          this.parent.send({
            type: 'xstate.error',
            data: err
          });
        }

        throw err;
      }
    }

    switch (action.type) {
      case actionTypes.send:
        const sendAction = action as SendActionObject<TContext, TEvent>;

        if (typeof sendAction.delay === 'number') {
          this.defer(sendAction);
          return;
        } else {
          if (sendAction.to) {
            this.sendTo(sendAction._event, sendAction.to);
          } else {
            this.send(sendAction._event);
          }
        }
        break;

      case actionTypes.cancel:
        this.cancel((action as CancelAction).sendId);

        break;
      case actionTypes.start: {
        const activity = (action as ActivityActionObject<TContext, TEvent>)
          .activity as InvokeDefinition<TContext, TEvent>;

        // If the activity will be stopped right after it's started
        // (such as in transient states)
        // don't bother starting the activity.
        if (!this.state.activities[activity.type]) {
          break;
        }

        // Invoked services
        if (activity.type === ActionTypes.Invoke) {
          const serviceCreator: ServiceConfig<TContext> | undefined = this
            .machine.options.services
            ? this.machine.options.services[activity.src]
            : undefined;

          const { id, data } = activity;

          if (!IS_PRODUCTION) {
            warn(
              !('forward' in activity),
              // tslint:disable-next-line:max-line-length
              `\`forward\` property is deprecated (found in invocation of '${activity.src}' in in machine '${this.machine.id}'). ` +
                `Please use \`autoForward\` instead.`
            );
          }

          const autoForward =
            'autoForward' in activity
              ? activity.autoForward
              : !!activity.forward;

          if (!serviceCreator) {
            // tslint:disable-next-line:no-console
            if (!IS_PRODUCTION) {
              warn(
                false,
                `No service found for invocation '${activity.src}' in machine '${this.machine.id}'.`
              );
            }
            return;
          }

          const source = isFunction(serviceCreator)
            ? serviceCreator(context, _event.data)
            : serviceCreator;

          if (isPromiseLike(source)) {
            this.state.children[id] = this.spawnPromise(
              Promise.resolve(source),
              id
            );
          } else if (isFunction(source)) {
            this.state.children[id] = this.spawnCallback(source, id);
          } else if (isObservable<TEvent>(source)) {
            this.state.children[id] = this.spawnObservable(source, id);
          } else if (isMachine(source)) {
            // TODO: try/catch here
            this.state.children[id] = this.spawnMachine(
              data
                ? source.withContext(mapContext(data, context, _event))
                : source,
              {
                id,
                autoForward
              }
            );
          } else {
            // service is string
          }
        } else {
          this.spawnActivity(activity);
        }

        break;
      }
      case actionTypes.stop: {
        this.stopChild(action.activity.id);
        break;
      }

      case actionTypes.log:
        const { label, value } = action;

        if (label) {
          this.logger(label, value);
        } else {
          this.logger(value);
        }
        break;
      default:
        if (!IS_PRODUCTION) {
          warn(
            false,
            `No implementation found for action type '${action.type}'`
          );
        }
        break;
    }

    return undefined;
  }
  private stopChild(childId: string): void {
    const child = this.children.get(childId);
    if (!child) {
      return;
    }

    this.children.delete(childId);
    this.forwardTo.delete(childId);

    delete this.state.children[childId];

    if (isFunction(child.stop)) {
      child.stop();
    }
  }
  public spawn(entity: Spawnable, name: string, options?: SpawnOptions): Actor {
    if (isPromiseLike(entity)) {
      return this.spawnPromise(Promise.resolve(entity), name);
    } else if (isFunction(entity)) {
      return this.spawnCallback(entity as InvokeCallback, name);
    } else if (isActor(entity)) {
      return this.spawnActor(entity);
    } else if (isObservable<TEvent>(entity)) {
      return this.spawnObservable(entity, name);
    } else if (isMachine(entity)) {
      return this.spawnMachine(entity, { ...options, id: name });
    } else {
      throw new Error(
        `Unable to spawn entity "${name}" of type "${typeof entity}".`
      );
    }
  }
  public spawnMachine<
    TChildContext,
    TChildStateSchema,
    TChildEvent extends EventObject
  >(
    machine: StateMachine<TChildContext, TChildStateSchema, TChildEvent>,
    options: { id?: string; autoForward?: boolean; sync?: boolean } = {}
  ): Interpreter<TChildContext, TChildStateSchema, TChildEvent> {
    const childService = new Interpreter(machine, {
      ...this.options, // inherit options from this interpreter
      parent: this,
      id: options.id || machine.id
    });

    const resolvedOptions = {
      ...DEFAULT_SPAWN_OPTIONS,
      ...options
    };

    if (resolvedOptions.sync) {
      childService.onTransition(state => {
        this.send(actionTypes.update as any, {
          state,
          id: childService.id
        });
      });
    }

    childService
      .onDone(doneEvent => {
        this.send(toSCXMLEvent(doneEvent as any, { origin: childService.id }));
      })
      .start();

    const actor = childService;

    this.children.set(childService.id, actor as Actor<
      State<TChildContext, TChildEvent>,
      TChildEvent
    >);

    if (resolvedOptions.autoForward) {
      this.forwardTo.add(childService.id);
    }

    return actor;
  }
  private spawnPromise<T>(promise: Promise<T>, id: string): Actor<T, never> {
    let canceled = false;

    promise.then(
      response => {
        if (!canceled) {
          this.send(
            toSCXMLEvent(doneInvoke(id, response) as any, { origin: id })
          );
        }
      },
      errorData => {
        if (!canceled) {
          const errorEvent = error(id, errorData);
          try {
            // Send "error.platform.id" to this (parent).
            this.send(toSCXMLEvent(errorEvent as any, { origin: id }));
          } catch (error) {
            reportUnhandledExceptionOnInvocation(errorData, error, id);
            if (this.devTools) {
              this.devTools.send(errorEvent, this.state);
            }
            if (this.machine.strict) {
              // it would be better to always stop the state machine if unhandled
              // exception/promise rejection happens but because we don't want to
              // break existing code so enforce it on strict mode only especially so
              // because documentation says that onError is optional
              this.stop();
            }
          }
        }
      }
    );

    const actor = {
      id,
      send: () => void 0,
      subscribe: (next, handleError, complete) => {
        let unsubscribed = false;
        promise.then(
          response => {
            if (unsubscribed) {
              return;
            }
            next && next(response);
            if (unsubscribed) {
              return;
            }
            complete && complete();
          },
          err => {
            if (unsubscribed) {
              return;
            }
            handleError(err);
          }
        );

        return {
          unsubscribe: () => (unsubscribed = true)
        };
      },
      stop: () => {
        canceled = true;
      },
      toJSON() {
        return { id };
      }
    };

    this.children.set(id, actor);

    return actor;
  }
  private spawnCallback(callback: InvokeCallback, id: string): Actor {
    let canceled = false;
    const receivers = new Set<(e: EventObject) => void>();
    const listeners = new Set<(e: EventObject) => void>();

    const receive = (e: TEvent) => {
      listeners.forEach(listener => listener(e));
      if (canceled) {
        return;
      }
      this.send(e);
    };

    let callbackStop;

    try {
      callbackStop = callback(receive, newListener => {
        receivers.add(newListener);
      });
    } catch (err) {
      this.send(error(id, err) as any);
    }

    if (isPromiseLike(callbackStop)) {
      // it turned out to be an async function, can't reliably check this before calling `callback`
      // because transpiled async functions are not recognizable
      return this.spawnPromise(callbackStop as Promise<any>, id);
    }

    const actor = {
      id,
      send: event => receivers.forEach(receiver => receiver(event)),
      subscribe: next => {
        listeners.add(next);

        return {
          unsubscribe: () => {
            listeners.delete(next);
          }
        };
      },
      stop: () => {
        canceled = true;
        if (isFunction(callbackStop)) {
          callbackStop();
        }
      },
      toJSON() {
        return { id };
      }
    };

    this.children.set(id, actor);

    return actor;
  }
  private spawnObservable<T extends TEvent>(
    source: Subscribable<T>,
    id: string
  ): Actor {
    const subscription = source.subscribe(
      value => {
        this.send(toSCXMLEvent(value, { origin: id }));
      },
      err => {
        this.send(toSCXMLEvent(error(id, err) as any, { origin: id }));
      },
      () => {
        this.send(toSCXMLEvent(doneInvoke(id) as any, { origin: id }));
      }
    );

    const actor = {
      id,
      send: () => void 0,
      subscribe: (next, handleError, complete) => {
        return source.subscribe(next, handleError, complete);
      },
      stop: () => subscription.unsubscribe(),
      toJSON() {
        return { id };
      }
    };

    this.children.set(id, actor);

    return actor;
  }
  private spawnActor<T extends Actor>(actor: T): T {
    this.children.set(actor.id, actor);

    return actor;
  }
  private spawnActivity(activity: ActivityDefinition<TContext, TEvent>): void {
    const implementation =
      this.machine.options && this.machine.options.activities
        ? this.machine.options.activities[activity.type]
        : undefined;

    if (!implementation) {
      if (!IS_PRODUCTION) {
        warn(false, `No implementation found for activity '${activity.type}'`);
      }
      // tslint:disable-next-line:no-console
      return;
    }

    // Start implementation
    const dispose = implementation(this.state.context, activity);
    this.spawnEffect(activity.id, dispose);
  }
  private spawnEffect(
    id: string,
    dispose?: DisposeActivityFunction | void
  ): void {
    this.children.set(id, {
      id,
      send: () => void 0,
      subscribe: () => {
        return { unsubscribe: () => void 0 };
      },
      stop: dispose || undefined,
      toJSON() {
        return { id };
      }
    });
  }

  private attachDev(): void {
    if (this.options.devTools && typeof window !== 'undefined') {
      if ((window as any).__REDUX_DEVTOOLS_EXTENSION__) {
        const devToolsOptions =
          typeof this.options.devTools === 'object'
            ? this.options.devTools
            : undefined;
        this.devTools = (window as any).__REDUX_DEVTOOLS_EXTENSION__.connect(
          {
            name: this.id,
            autoPause: true,
            stateSanitizer: (state: State<any, any>): object => {
              return {
                value: state.value,
                context: state.context,
                actions: state.actions
              };
            },
            ...devToolsOptions,
            features: {
              jump: false,
              skip: false,
              ...(devToolsOptions
                ? (devToolsOptions as any).features
                : undefined)
            }
          },
          this.machine
        );
        this.devTools.init(this.state);
      }

      // add XState-specific dev tooling hook
      registerService(this);
    }
  }
  public toJSON() {
    return {
      id: this.id
    };
  }

  public [symbolObservable]() {
    return this;
  }
}

const createNullActor = (name: string = 'null'): Actor => ({
  id: name,
  send: () => void 0,
  subscribe: () => {
    // tslint:disable-next-line:no-empty
    return { unsubscribe: () => {} };
  },
  toJSON: () => ({ id: name })
});

const resolveSpawnOptions = (nameOrOptions?: string | SpawnOptions) => {
  if (isString(nameOrOptions)) {
    return { ...DEFAULT_SPAWN_OPTIONS, name: nameOrOptions };
  }

  return {
    ...DEFAULT_SPAWN_OPTIONS,
    name: uniqueId(),
    ...nameOrOptions
  };
};

export function spawn<TC, TE extends EventObject>(
  entity: StateMachine<TC, any, TE>,
  nameOrOptions?: string | SpawnOptions
): Interpreter<TC, any, TE>;
export function spawn(
  entity: Spawnable,
  nameOrOptions?: string | SpawnOptions
): Actor;
export function spawn(
  entity: Spawnable,
  nameOrOptions?: string | SpawnOptions
): Actor {
  const resolvedOptions = resolveSpawnOptions(nameOrOptions);

  return withServiceScope(undefined, service => {
    if (!IS_PRODUCTION) {
      warn(
        !!service,
        `Attempted to spawn an Actor (ID: "${
          isMachine(entity) ? entity.id : 'undefined'
        }") outside of a service. This will have no effect.`
      );
    }

    if (service) {
      return service.spawn(entity, resolvedOptions.name, resolvedOptions);
    } else {
      return createNullActor(resolvedOptions.name);
    }
  });
}

/**
 * Creates a new Interpreter instance for the given machine with the provided options, if any.
 *
 * @param machine The machine to interpret
 * @param options Interpreter options
 */
export function interpret<
  TContext = DefaultContext,
  TStateSchema extends StateSchema = any,
  TEvent extends EventObject = EventObject
>(
  machine: StateMachine<TContext, TStateSchema, TEvent>,
  options?: Partial<InterpreterOptions>
) {
  const interpreter = new Interpreter<TContext, TStateSchema, TEvent>(
    machine,
    options
  );

  return interpreter;
}
