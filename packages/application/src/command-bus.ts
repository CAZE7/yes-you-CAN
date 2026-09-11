/**
 * Command bus (target architecture §8, §9).
 *
 * Every client — Web, Desktop, Mobile, CLI, Cloud API, AI agent — talks to
 * the platform by dispatching commands and queries, never by calling
 * protocol code. Commands change state, queries read state; the separation is
 * kept here so the two sides can evolve independently (a query can later be
 * served from a read model without touching command handlers).
 *
 * The bus itself is deliberately tiny: register a handler per kind, dispatch
 * by kind. Workflows, retries and middleware can wrap it later without
 * changing the contract.
 */

/**
 * A command (changes state) or query (reads state).
 *
 * `__resultType` is a phantom field: it never exists at runtime, it only lets
 * `dispatch` infer the handler's return type from the command object.
 */
export interface Command<TResult = unknown> {
  readonly kind: string;
  readonly __resultType?: TResult;
}

export interface Query<TResult = unknown> {
  readonly kind: string;
  readonly __resultType?: TResult;
}

export type CommandHandler<C extends Command<TResult>, TResult> = (command: C) => Promise<TResult> | TResult;
export type QueryHandler<Q extends Query<TResult>, TResult> = (query: Q) => Promise<TResult> | TResult;

/** Raised when a command/query is dispatched that nobody is registered for. */
export class NoHandlerError extends Error {
  constructor(readonly kind: string, kindLabel: 'command' | 'query' = 'command') {
    super(`no ${kindLabel} handler registered for "${kind}"`);
    this.name = 'NoHandlerError';
  }
}

/** Raised when two handlers fight over the same kind — always a wiring bug. */
export class DuplicateHandlerError extends Error {
  constructor(readonly kind: string) {
    super(`a handler is already registered for "${kind}"`);
    this.name = 'DuplicateHandlerError';
  }
}

type AnyHandler = (input: Command<never>) => unknown;

export class CommandBus {
  private readonly commandHandlers = new Map<string, AnyHandler>();
  private readonly queryHandlers = new Map<string, AnyHandler>();

  registerCommand<TResult>(kind: string, handler: (command: Command<TResult>) => Promise<TResult> | TResult): void {
    if (this.commandHandlers.has(kind)) throw new DuplicateHandlerError(kind);
    this.commandHandlers.set(kind, handler as AnyHandler);
  }

  registerQuery<TResult>(kind: string, handler: (query: Query<TResult>) => Promise<TResult> | TResult): void {
    if (this.queryHandlers.has(kind)) throw new DuplicateHandlerError(kind);
    this.queryHandlers.set(kind, handler as AnyHandler);
  }

  /** Execute a command; resolves with the handler's result. */
  async dispatch<TResult>(command: Command<TResult>): Promise<TResult> {
    const handler = this.commandHandlers.get(command.kind);
    if (!handler) throw new NoHandlerError(command.kind, 'command');
    return (await handler(command as Command<never>)) as TResult;
  }

  /** Execute a query; resolves with the handler's result. */
  async query<TResult>(readModel: Query<TResult>): Promise<TResult> {
    const handler = this.queryHandlers.get(readModel.kind);
    if (!handler) throw new NoHandlerError(readModel.kind, 'query');
    return (await handler(readModel as Command<never>)) as TResult;
  }

  hasCommand(kind: string): boolean {
    return this.commandHandlers.has(kind);
  }

  hasQuery(kind: string): boolean {
    return this.queryHandlers.has(kind);
  }

  commandKinds(): string[] {
    return Array.from(this.commandHandlers.keys()).sort();
  }

  queryKinds(): string[] {
    return Array.from(this.queryHandlers.keys()).sort();
  }
}
