export type ItemKind = "vertex" | "linedef" | "sector" | "thing";

export interface ItemRef {
  kind: ItemKind;
  index: number;
}

/** Error raised by an operation that can't apply; the message is shown to the user. */
export class OpError extends Error {}
