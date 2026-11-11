export type OpErrorCode =
  | "NOT_FOUND"
  | "OVERLAP"
  | "WRONG_TRACK_KIND"
  | "TRACK_LOCKED"
  | "INVALID"
  | "TRIM_OUT_OF_RANGE"
  | "DUPLICATE_ID";

export class OpError extends Error {
  code: OpErrorCode;
  opIndex: number;

  constructor(code: OpErrorCode, message: string, opIndex: number) {
    super(message);
    this.name = "OpError";
    this.code = code;
    this.opIndex = opIndex;
  }
}
