// SPDX-License-Identifier: Apache-2.0

/** `T` with every property that may be `undefined` turned into an optional one. */
export type DefinedOnly<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/**
 * Drops `undefined` properties, so optional CLI flags or form fields can be passed on
 * without overriding defaults (and without breaking `exactOptionalPropertyTypes`).
 */
export function definedOnly<T extends object>(obj: T): DefinedOnly<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as DefinedOnly<T>;
}
