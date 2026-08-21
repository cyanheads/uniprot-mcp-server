/**
 * @fileoverview Shared rejection assertions for the test suite.
 *
 * Replaces the `promise.catch((e) => e as McpError)` idiom. That idiom types as
 * `T | McpError` — which no longer compiles now that `tests/` is typechecked —
 * and, more importantly, lets a call that unexpectedly *resolves* flow into the
 * assertions as though it had thrown, turning a real regression into a
 * confusing `undefined`-property failure. These helpers make a non-rejection a
 * loud, self-describing failure.
 *
 * @module tests/helpers
 */

import { McpError } from '@cyanheads/mcp-ts-core/errors';

/**
 * Await a call that must reject, and return the thrown `Error`.
 *
 * Takes `unknown` because a definition's `handler` is typed `T | Promise<T>` —
 * a synchronous handler is legal — so the argument is not always a `PromiseLike`.
 */
export async function expectRejection(call: unknown): Promise<Error> {
  try {
    await call;
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`Expected the call to reject with an Error, got: ${String(err)}`);
  }
  throw new Error('Expected the call to reject, but it resolved.');
}

/** Await a call that must reject with an `McpError`, and return it. */
export async function expectMcpError(call: unknown): Promise<McpError> {
  const err = await expectRejection(call);
  if (!(err instanceof McpError)) {
    throw new Error(`Expected an McpError, got ${err.name}: ${err.message}`);
  }
  return err;
}

/**
 * Narrow an optional definition field the definition under test does declare
 * (`params` on a resource, `enrichment` on a tool). Both are optional on the
 * shared definition type, so reading them under a typechecked `tests/` needs a
 * narrowing step — this makes an accidental removal a named failure rather than
 * a `possibly undefined` diagnostic silenced with `!`.
 */
export function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Expected the definition to declare ${what}.`);
  return value;
}
