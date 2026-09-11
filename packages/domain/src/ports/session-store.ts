/**
 * Session store port (target architecture §21: "Cloud ebenfalls nicht in den
 * Core").
 *
 * The core never knows whether a session lands on disk, in a local cache or
 * in a cloud backend. It depends only on this port; a
 * `FileSystemSessionRepository`, a `CloudSessionRepository` or a
 * `PostgresSessionRepository` are implementations chosen at the composition
 * root. This is what makes offline-first — and later cloud sync — possible
 * without touching the diagnostic stack (§22).
 *
 * The port is generic over the session shape: the domain does not dictate the
 * persistence format, only the operations. Versioning and migrations belong
 * to the implementation (§16, §17).
 */

export interface StoredSessionInfo {
  id: string;
  startedAt: string;
  endedAt?: string;
  title?: string;
  schemaVersion?: number;
}

export interface SessionStore<TSession extends { id: string }> {
  save(session: TSession): Promise<void>;
  load(id: string): Promise<TSession | undefined>;
  list(): Promise<readonly StoredSessionInfo[]>;
  exists(id: string): Promise<boolean>;
  delete(id: string): Promise<void>;
}

/** In-memory store for tests, simulation and ephemeral runs. */
export class InMemorySessionStore<TSession extends { id: string }>
  implements SessionStore<TSession>
{
  private readonly sessions = new Map<string, TSession>();

  constructor(
    private readonly summarize: (session: TSession) => StoredSessionInfo = defaultSummarize,
  ) {}

  async save(session: TSession): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async load(id: string): Promise<TSession | undefined> {
    return this.sessions.get(id);
  }

  async list(): Promise<readonly StoredSessionInfo[]> {
    return Array.from(this.sessions.values()).map(this.summarize);
  }

  async exists(id: string): Promise<boolean> {
    return this.sessions.has(id);
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }
}

function defaultSummarize<TSession extends { id: string }>(session: TSession): StoredSessionInfo {
  const maybe = session as {
    startedAt?: unknown;
    endedAt?: unknown;
    title?: unknown;
    schemaVersion?: unknown;
  };
  return {
    id: session.id,
    startedAt: typeof maybe.startedAt === "string" ? maybe.startedAt : "",
    ...(typeof maybe.endedAt === "string" ? { endedAt: maybe.endedAt } : {}),
    ...(typeof maybe.title === "string" ? { title: maybe.title } : {}),
    ...(typeof maybe.schemaVersion === "number" ? { schemaVersion: maybe.schemaVersion } : {}),
  };
}
