/**
 * CHUNK_3_IPC — the channel registry: its type, its shared zod primitives, and the one
 * function that assembles it.
 *
 * Implements `docs/build/interfaces/ipc-schema-registry.md` §2, §3 and §6.
 *
 * This file is the seam. Agent B2 owns it; agents B3 (read domains) and B4 (action domains)
 * import `defineChannel` and the primitives below and never edit this file. Everything a
 * handler author needs is here, and every rule a handler author could get wrong is asserted
 * here at module-load time rather than left to review.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WORKED EXAMPLE — how a handler author registers a channel
 *
 *   // desktop/ipc/action/proposals.ts        (B4)
 *   import { z } from 'zod';
 *   import { runReject } from '../../../src/services/action/index.js';
 *   import { defineChannel, entityId, reason, passthrough, strict, type RegistryEntry }
 *     from '../registry.js';
 *
 *   export const proposalsEntries: readonly RegistryEntry[] = [
 *     defineChannel({
 *       channel: 'aphub:proposals:reject',
 *       role: ['owner_controller', 'bookkeeper'],   // SAME set the route had — index.ts:179
 *       method: 'POST',                             // never inferred; see envelope.ts
 *       pathTemplate: '/api/proposals/:proposalId/reject',
 *       bodyKeys: ['reason', 'markDuplicate'],
 *       request: strict({
 *         proposalId: entityId,
 *         reason,
 *         markDuplicate: z.boolean().optional(),
 *       }),
 *       response: passthrough({ proposal_id: z.number(), status: z.string() }),
 *       validationMessage: 'Add a short reason before rejecting this item.',
 *       invoke: (request, payload) => runReject(request, payload.proposalId as number),
 *     }),
 *   ];
 *
 * Then add the channel NAME (and nothing else) to your directory's zero-import
 * `channels.ts`, and export your entries from your directory's barrel. That is the whole
 * contract. `defineChannel` throws immediately — at import, so a test or the build catches it
 * — if the entry breaks any rule below.
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Rules `defineChannel` enforces, and why each one exists:
 *
 *  1. `.strict()` on the request object. This is the mechanism that enforces token custody:
 *     a renderer that adds a `token` field gets `VALIDATION` before any service is reached.
 *     Not optional, not per-channel (`ipc-schema-registry.md` §3a).
 *  2. No identity-shaped key in the request schema. Belt to `.strict()`'s braces — a channel
 *     cannot even DECLARE that it accepts a tenant or a role (`ipc-auth-context.md` §1).
 *  3. Every `:param` in the path template is a REQUIRED key of the schema, so synthesis can
 *     never build a URL with a hole in it.
 *  4. Every schema key has a destination — a path param, a query param or a body key. A key
 *     with none is silently dropped, which is how a "working" screen loses a field
 *     (`ipc-schema-registry.md` §2).
 *  5. A `GET` declares no body keys (`ipc-envelope.md` §5.2a).
 *  6. Response schemas are NOT strict, so a service adding a column cannot break the app at
 *     runtime (`ipc-schema-registry.md` §3f).
 *  7. `validationMessage`, when supplied, is plain language and names no channel.
 */

import { z } from 'zod';
import type { Role } from '../../src/auth/guard.js';
import { CHANNEL_PATTERN } from '../channels.js';
import { IDENTITY_FIELDS } from './context.js';
import { pathParamsOf, type IpcMethod } from './envelope.js';

export type { IpcMethod };

/** One channel. `docs/build/interfaces/ipc-schema-registry.md` §2. */
export interface RegistryEntry {
  /** `aphub:<domain>:<action>`, matching `CHANNEL_PATTERN` — `desktop/channels.ts:28`. */
  readonly channel: string;
  /**
   * The SAME role requirement the route had — not stricter, not looser, not unified.
   *
   * Documentation and test fixture, NOT a second gate (`ipc-auth-context.md` §5): the real
   * gate is the `role` argument that reaches `readContext`, which for most channels is baked
   * into the wrapper `invoke` calls. Where the dispatcher does choose it (the `runRead`
   * channels, via `opts.role`) the value MUST equal this field.
   *
   * `'any'` means `readContext` is called with no role argument — any authenticated role.
   */
  readonly role: readonly Role[] | 'any';
  /** Validated BEFORE the service is reached. Must be a `.strict()` object. */
  readonly request: z.ZodTypeAny;
  /** Documents the success payload. Must NOT be strict. */
  readonly response: z.ZodTypeAny;
  /** Never inferred — `runOnboardingAction` branches on it (`onboarding.ts:43`). */
  readonly method: IpcMethod;
  readonly pathTemplate: string;
  /** Payload keys that become query-string params (`ipc-envelope.md` §5.3). */
  readonly queryParams?: readonly string[];
  /** Payload keys that become the JSON body. Omitted keys are never forwarded. */
  readonly bodyKeys?: readonly string[];
  /**
   * ONE plain-language sentence for a schema failure on this channel, not one per field
   * (`ipc-schema-registry.md` §5). Optional; the generic `VALIDATION` string is used when it
   * is absent.
   *
   * The dispatcher NEVER derives a message from `ZodError.issues`: `issue.path` leaks internal
   * field names and `issue.received` echoes the caller's own value back.
   */
  readonly validationMessage?: string;
  /** Calls the real, unmodified `src/services` wrapper. Nothing under `src/**` is edited. */
  readonly invoke: (request: Request, payload: Record<string, unknown>) => Promise<Response>;
}

/**
 * A directory's contribution: the zero-import channel-name list, and the entries barrel.
 *
 * The names are stated twice on purpose. `desktop/channels.ts` is bundled into the sandboxed
 * preload, so its imports are dragged into that bundle; a channel list that imported the
 * registry would pull zod and `src/**` into a sandboxed context and reproduce the CHUNK_2
 * `Dynamic require of "events"` failure at the preload layer
 * (`docs/build/file-ownership.md:67-73`). The duplication is made safe by the symmetry
 * assertion in `buildRegistry`, not by discipline.
 */
export interface ChannelContribution {
  readonly channels: readonly string[];
  readonly entries: readonly RegistryEntry[];
}

/** The assembled registry. */
export interface IpcRegistry {
  readonly byChannel: Readonly<Record<string, RegistryEntry>>;
  /** Every channel name, from the zero-import lists. Set-equal to `keys(byChannel)`. */
  readonly channels: readonly string[];
}

/**
 * A registry defect. Thrown at module load or at assembly — a build/test failure, never a
 * production request failure, and never anything the renderer sees. Channel names appear in
 * these messages deliberately: they go to the developer, not across the bridge.
 */
export class RegistryDefect extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryDefect';
  }
}

// --- shared zod primitives ---------------------------------------------------------------
// These live here because B2 owns this file and B3/B4 import from it. There is no `types.ts`.

/**
 * An entity id: a positive integer, and NOT the numeric-string form.
 *
 * `isValidId` tolerates numeric strings because pg returns `bigint` columns as strings
 * (`src/services/index.ts:51-57`), but an IPC payload is authored by our own renderer and has
 * no reason to send `"501"`. One accepted type removes a class of coercion bug.
 */
export const entityId = z.number().int().positive();

/**
 * An id as it comes BACK from the database — for RESPONSE schemas only.
 *
 * pg returns `bigint` columns as strings (`src/services/index.ts:51-57`), and `ctx.tenantId`
 * is one of them, so a response schema that demands `z.number()` rejects real data and the
 * dispatcher fails the call closed. Verified against a live query in
 * `test/ipc-foundation.test.ts`. Request-side ids stay `entityId` — number only.
 */
export const persistedId = z.union([z.number(), z.string()]);

/** A required reason. Cap mirrors `src/statements/review.ts:160`. */
export const reason = z.string().trim().min(1).max(1000);

/** An optional reason, same cap. */
export const optionalReason = reason.optional();

/** A short identifier or label. Schema-owned cap (`ipc-schema-registry.md` §3c). */
export const shortText = z.string().trim().min(1).max(255);

/** A free-text filter value the service accepts unconstrained. Schema-owned cap. */
export const filterText = z.string().trim().min(1).max(64);

/**
 * A `.strict()` request object. Use this instead of `z.object(...)` so the strictness cannot
 * be forgotten. Nested objects must be `.strict()` too — `providerRef` on
 * `aphub:statements:match-line` is an object (`src/statements/http.ts:50`) and must not become
 * a bag for arbitrary keys.
 */
export function strict<T extends z.ZodRawShape>(shape: T): z.ZodObject<T, 'strict'> {
  return z.object(shape).strict();
}

/** A response object. Passthrough, so a new service column cannot break the app. */
export function passthrough<T extends z.ZodRawShape>(shape: T): z.ZodObject<T, 'passthrough'> {
  return z.object(shape).passthrough();
}

// --- entry validation --------------------------------------------------------------------

/**
 * Unwrap the object at the base of a schema.
 *
 * `.superRefine()` wraps a `ZodObject` in a `ZodEffects` — the deny-list refinement on
 * `aphub:replies:send` (`ipc-schema-registry.md` §7) and the "at least one of" refinement on
 * `aphub:dimension-mappings:select-alternate` both do — so the strictness and key checks have
 * to see through the wrapper rather than give up on it.
 */
function baseObject(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape, z.UnknownKeysParam> | null {
  let current: z.ZodTypeAny = schema;
  for (let depth = 0; depth < 12; depth += 1) {
    if (current instanceof z.ZodObject) return current as z.ZodObject<z.ZodRawShape, z.UnknownKeysParam>;
    if (current instanceof z.ZodEffects) {
      current = current.innerType() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.removeDefault() as z.ZodTypeAny;
      continue;
    }
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodReadonly ||
      current instanceof z.ZodBranded
    ) {
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    return null;
  }
  return null;
}

function unknownKeysOf(obj: z.ZodObject<z.ZodRawShape, z.UnknownKeysParam>): string {
  return String((obj._def as { unknownKeys?: unknown }).unknownKeys ?? 'strip');
}

function canonicalKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const IDENTITY_SET: ReadonlySet<string> = new Set(IDENTITY_FIELDS);

/**
 * Validate one entry and return it unchanged.
 *
 * Called by every handler author at module scope, so a mistake surfaces the moment the module
 * is imported — in a unit test or in `npm run desktop:build`, not on a user's machine.
 */
export function defineChannel(entry: RegistryEntry): RegistryEntry {
  const where = entry.channel;

  if (typeof entry.channel !== 'string' || !CHANNEL_PATTERN.test(entry.channel)) {
    throw new RegistryDefect(`MALFORMED_CHANNEL: ${String(entry.channel)}`);
  }

  const request = baseObject(entry.request);
  if (request === null) {
    throw new RegistryDefect(`REQUEST_SCHEMA_NOT_AN_OBJECT: ${where}`);
  }
  if (unknownKeysOf(request) !== 'strict') {
    // Rule 1. Without this, a renderer-supplied identity field would be silently stripped
    // instead of rejected, and the "never merged" guarantee would rest on nothing.
    throw new RegistryDefect(`REQUEST_SCHEMA_NOT_STRICT: ${where}`);
  }

  const shape = request.shape;
  const keys = Object.keys(shape);

  const identity = keys.filter((k) => IDENTITY_SET.has(canonicalKey(k)));
  if (identity.length > 0) {
    // Rule 2. Identity is resolved from the session, never asserted by the caller.
    throw new RegistryDefect(`IDENTITY_FIELD_IN_SCHEMA: ${where} declares ${identity.join(', ')}`);
  }

  const pathParams = pathParamsOf(entry.pathTemplate);
  for (const param of pathParams) {
    const field = shape[param];
    if (field === undefined) {
      throw new RegistryDefect(`PATH_PARAM_NOT_IN_SCHEMA: ${where} needs '${param}'`);
    }
    if (field.isOptional()) {
      // Rule 3. An optional path param would synthesize `/api/statements//file`.
      throw new RegistryDefect(`PATH_PARAM_OPTIONAL: ${where} '${param}'`);
    }
  }

  const queryParams = entry.queryParams ?? [];
  const bodyKeys = entry.bodyKeys ?? [];
  if (entry.method === 'GET' && bodyKeys.length > 0) {
    // Rule 5. A GET with a body throws TypeError in the Request constructor.
    throw new RegistryDefect(`BODY_ON_GET: ${where}`);
  }

  const routed = new Set<string>([...pathParams, ...queryParams, ...bodyKeys]);
  for (const key of routed) {
    if (shape[key] === undefined) {
      throw new RegistryDefect(`ROUTED_KEY_NOT_IN_SCHEMA: ${where} routes '${key}'`);
    }
  }
  for (const key of keys) {
    if (!routed.has(key)) {
      // Rule 4. Declaring the key as a query param is enough even when the handler closure
      // reads the validated value directly — `ipc-envelope.md` §5.3 allows either, and
      // declaring it keeps the synthetic URL honest.
      throw new RegistryDefect(`UNROUTED_PAYLOAD_KEY: ${where} '${key}'`);
    }
  }

  const response = baseObject(entry.response);
  if (response !== null && unknownKeysOf(response) === 'strict') {
    throw new RegistryDefect(`RESPONSE_SCHEMA_STRICT: ${where}`);
  }

  if (entry.validationMessage !== undefined) {
    const message = entry.validationMessage;
    if (message.trim() === '' || message.includes('aphub:') || /[${}]/.test(message)) {
      // Rule 7. No channel name, no interpolation site.
      throw new RegistryDefect(`VALIDATION_MESSAGE_NOT_PLAIN: ${where}`);
    }
  }

  return entry;
}

/**
 * Assemble the registry. The ONE assembly point (`ipc-schema-registry.md` §6.3) — a second
 * one would let a channel exist in a place the symmetry check does not look.
 *
 * Both directions of the name/entry symmetry are enforced, because a mismatch is a defect
 * either way: a name with no entry is dead surface the preload would relay into nothing, and
 * an entry with no name is unreachable and would fail silently at `desktop/preload.ts:56`.
 */
export function buildRegistry(contributions: readonly ChannelContribution[]): IpcRegistry {
  const byChannel: Record<string, RegistryEntry> = {};
  for (const contribution of contributions) {
    for (const entry of contribution.entries) {
      defineChannel(entry);
      if (byChannel[entry.channel] !== undefined) {
        throw new RegistryDefect(`DUPLICATE_CHANNEL: ${entry.channel}`);
      }
      byChannel[entry.channel] = entry;
    }
  }

  const declared: string[] = [];
  const declaredSet = new Set<string>();
  for (const contribution of contributions) {
    for (const channel of contribution.channels) {
      if (declaredSet.has(channel)) throw new RegistryDefect(`DUPLICATE_CHANNEL_NAME: ${channel}`);
      declaredSet.add(channel);
      declared.push(channel);
    }
  }

  for (const channel of declared) {
    if (byChannel[channel] === undefined) {
      throw new RegistryDefect(`CHANNEL_WITHOUT_ENTRY: ${channel}`);
    }
  }
  for (const channel of Object.keys(byChannel)) {
    if (!declaredSet.has(channel)) {
      throw new RegistryDefect(`ENTRY_WITHOUT_CHANNEL: ${channel}`);
    }
  }

  return Object.freeze({
    byChannel: Object.freeze(byChannel),
    channels: Object.freeze(declared),
  });
}
