/** Tiny typed event emitter — no Node dependency so it also runs in the browser bundle. */

export type Listener<T> = (payload: T) => void;

export interface Disposable {
  dispose(): void;
}

export class TypedEmitter<Events extends Record<string, unknown>> {
  private readonly map = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Disposable {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(listener as Listener<never>);
    return {
      dispose: () => {
        set?.delete(listener as Listener<never>);
      },
    };
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.map.get(event)?.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.map.get(event);
    if (!set) return;
    for (const listener of Array.from(set)) (listener as Listener<Events[K]>)(payload);
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.map.get(event)?.size ?? 0;
  }

  removeAllListeners(): void {
    this.map.clear();
  }
}
