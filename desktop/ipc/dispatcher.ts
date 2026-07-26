/**
 * CHUNK_3_IPC — the dispatcher. Registers one `ipcMain` handler per product channel.
 *
 * Extends the CHUNK_1 pattern at `desktop/main.ts:235-249` rather than replacing it: same
 * `ipcMain.handle` surface, same `isAllowedChannel` assertion before registering, same
 * `{ ok, data }` / `{ ok, code, message }` envelope. The shell channels stay exactly as they
 * are.
 *
 * `ipcMain` is INJECTED rather than imported. Two reasons, both practical: the dispatcher is
 * then unit-testable outside Electron, and `desktop/main.ts` stays the only file that decides
 * what the shell wires up.
 *
 * Order of operations, and why it is this order:
 *
 *   1. allowlist          the second independent check, behind `desktop/preload.ts:56`
 *   2. registry lookup    an unknown channel is refused with the SAME object the preload uses
 *   3. database readiness  answered without calling any service
 *   4. identity screen    a payload naming a tenant/role/token is rejected, never merged
 *   5. zod validation     ← the last line before any `src/**` code runs
 *   6. synthesize Request  cookie from the main process, never from the payload
 *   7. invoke              the real, unmodified service wrapper
 *   8. decode + validate   plain-language message looked up from the normalized code
 *
 * Step 5 is the one the chunk spec makes a test: "a channel invoked with a payload that fails
 * its zod schema rejects with a typed code and never reaches the service"
 * (`specs/03_CHUNK_3_IPC.md:51`). `safeParse` is used, never `parse`: a thrown `ZodError`
 * escaping into `ipcMain.handle` would be serialized by Electron into a rejected promise whose
 * message is a zod dump — field paths, received values and all.
 */

import { IPC_CHANNELS, SHELL_CHANNELS, isAllowedChannel } from '../channels.js';
import { currentSessionCookie, identityFieldsIn } from './context.js';
import { decode, failure, synthesize, type IpcResult } from './envelope.js';
import { plainMessage } from './errors.js';
import {
  buildRegistry,
  type ChannelContribution,
  type IpcRegistry,
  type RegistryEntry,
} from './registry.js';

/** What the shell knows about the private database. `desktop/main.ts` is the source of truth. */
export type DatabaseState = 'ready' | 'starting' | 'failed';

/** The slice of `ipcMain` the dispatcher uses. Electron's `ipcMain` satisfies it. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => Promise<IpcResult>): void;
}

export interface DispatcherOptions {
  /** The read and action contributions. Empty is valid: it registers nothing. */
  readonly contributions: readonly ChannelContribution[];
  /**
   * Read at dispatch time, not captured, so a database that comes up mid-session starts
   * working without a restart.
   */
  readonly databaseState: () => DatabaseState;
  /**
   * Allowlist members this dispatcher does not own — the shell's own channels, plus the
   * connect and backup channels CHUNK_5 and CHUNK_7 add. Anything else in `IPC_CHANNELS`
   * without a registry entry is a defect, not a warning.
   */
  readonly reservedChannels?: readonly string[];
}

export interface DispatcherDeps extends DispatcherOptions {
  readonly ipcMain: IpcMainLike;
}

export interface Dispatcher {
  readonly registry: IpcRegistry;
  dispatch(channel: string, payload?: unknown): Promise<IpcResult>;
}

/**
 * Byte-identical to `CHANNEL_REFUSED` in `desktop/preload.ts:39-44`, including the absent
 * `status`.
 *
 * That identity is the point: a probing renderer cannot tell "this channel does not exist"
 * from "this channel failed", and no channel name is echoed back, so it learns nothing from
 * probing (`desktop/preload.ts:42`).
 */
const CHANNEL_REFUSED: IpcResult = Object.freeze({
  ok: false,
  code: 'INTERNAL',
  message: plainMessage('INTERNAL'),
});

/**
 * Build a dispatcher without touching Electron.
 *
 * Assembly happens here, through `buildRegistry`, so the duplicate-channel, schema-strictness
 * and name/entry symmetry checks all run before a single handler is registered. A defect
 * throws — at startup or in a test, never as a silent per-request failure.
 */
export function createDispatcher(options: DispatcherOptions): Dispatcher {
  const registry = buildRegistry(options.contributions);
  const databaseState = options.databaseState;

  function validationFailure(entry: RegistryEntry): IpcResult {
    // One authored message per channel, or the generic one. Never derived from ZodError.
    return failure('VALIDATION', 400, entry.validationMessage);
  }

  async function dispatch(channel: string, rawPayload?: unknown): Promise<IpcResult> {
    // 1 + 2. Both refusals answer identically, and neither names the channel.
    if (!isAllowedChannel(channel)) return CHANNEL_REFUSED;
    const entry = registry.byChannel[channel];
    if (entry === undefined) return CHANNEL_REFUSED;

    // 3. No service is called when the data is not open. The user gets a sentence with a next
    //    action rather than a failed query they cannot interpret.
    const database = databaseState();
    if (database !== 'ready') {
      return failure(database === 'starting' ? 'DB_STARTING' : 'DB_FAILED', 503);
    }

    // 4. Rejected, not ignored and not merged. `.strict()` would catch this too; this check
    //    exists so the refusal is explicit and so it holds even for a future non-strict entry
    //    that somehow got past `defineChannel`. The generic message discloses nothing about
    //    which field offended.
    if (identityFieldsIn(rawPayload).length > 0) return failure('VALIDATION', 400);

    // 5. The last line before any `src/**` code runs.
    const parsed = entry.request.safeParse(rawPayload ?? {});
    if (!parsed.success) return validationFailure(entry);
    const payload = parsed.data as Record<string, unknown>;

    // 6. The cookie comes from main-process state. There is no expression that could put a
    //    payload value here — `SessionCookie` is branded and only `context.ts` mints one.
    let cookie;
    try {
      cookie = currentSessionCookie();
    } catch {
      return failure('INTERNAL', 500);
    }

    // 7. The real wrapper, with no `deps` argument, so production takes the real adapters —
    //    exactly what the route files do today.
    let response: Response;
    try {
      response = await entry.invoke(synthesize(entry, payload, cookie), payload);
    } catch {
      return failure('INTERNAL', 500);
    }

    // 8. Decode, then check the success payload against the documented shape. Response schemas
    //    are passthrough, so a failure here means the shape genuinely drifted — fail closed
    //    rather than hand the renderer something it cannot render.
    const result = await decode(response);
    if (result.ok && result.data !== undefined && !entry.response.safeParse(result.data).success) {
      return failure('INTERNAL', 500);
    }
    return result;
  }

  return { registry, dispatch };
}

/**
 * Register every product channel on `ipcMain`.
 *
 * Refuses in BOTH directions, because a channel that exists in only one place is a defect:
 *
 *   - a registry entry whose name is not in `IPC_CHANNELS` is unreachable — the preload would
 *     refuse it at `desktop/preload.ts:56` and the failure would be silent;
 *   - an `IPC_CHANNELS` name with no registry entry is dead surface the bridge would relay
 *     into nothing.
 *
 * The name/entry symmetry inside the contributions is checked by `buildRegistry`.
 */
export function registerProductHandlers(deps: DispatcherDeps): Dispatcher {
  const dispatcher = createDispatcher(deps);
  const reserved = new Set<string>(deps.reservedChannels ?? SHELL_CHANNELS);

  for (const channel of dispatcher.registry.channels) {
    // The same assertion, and the same error, as `desktop/main.ts:237`.
    if (!isAllowedChannel(channel)) throw new Error('UNREGISTERED_CHANNEL');
  }
  for (const channel of IPC_CHANNELS) {
    if (reserved.has(channel)) continue;
    if (dispatcher.registry.byChannel[channel] === undefined) {
      throw new Error('CHANNEL_WITHOUT_HANDLER');
    }
  }

  for (const channel of dispatcher.registry.channels) {
    deps.ipcMain.handle(channel, (_event, payload) => dispatcher.dispatch(channel, payload));
  }

  return dispatcher;
}
