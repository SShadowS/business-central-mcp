export type Result<T, E = Error> = Ok<T> | Err<E>;
export interface Ok<T> { readonly ok: true; readonly value: T; }
export interface Err<E> { readonly ok: false; readonly error: E; }

export function ok<T>(value: T): Ok<T> { return { ok: true, value }; }
export function err<E>(error: E): Err<E> { return { ok: false, error }; }
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> { return result.ok === true; }
export function isErr<T, E>(result: Result<T, E>): result is Err<E> { return result.ok === false; }

export function unwrap<T, E>(result: Result<T, E>): T {
  if (isOk(result)) return result.value;
  throw result.error instanceof Error ? result.error : new Error(String(result.error));
}
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return isOk(result) ? result.value : fallback;
}
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return isOk(result) ? ok(fn(result.value)) : result;
}
export function andThen<T, U, E>(result: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
  return isOk(result) ? fn(result.value) : result;
}
export async function fromPromise<T>(promise: Promise<T>): Promise<Result<T, Error>> {
  try { return ok(await promise); } catch (e) { return err(e instanceof Error ? e : new Error(String(e))); }
}
