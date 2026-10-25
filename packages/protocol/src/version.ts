declare const __COHALL_VERSION__: string
export const version =
  typeof __COHALL_VERSION__ === "undefined" ? "0.0.0-development" : __COHALL_VERSION__
