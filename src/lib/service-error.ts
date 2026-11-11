import type { OpErrorCode } from "@/lib/timeline";

export type ErrorBody = { code: string; message: string; opIndex?: number; currentVersion?: number };

export type ServiceErrorCode = OpErrorCode | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT";

export class ServiceError extends Error {
  code: ServiceErrorCode;
  status: 400 | 403 | 404 | 409;
  // Declared, not defined, so an absent value is not an own property set to undefined.
  declare opIndex?: number;
  declare currentVersion?: number;

  constructor(
    code: ServiceErrorCode,
    status: 400 | 403 | 404 | 409,
    message: string,
    extra: { opIndex?: number; currentVersion?: number } = {},
  ) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = status;
    if (extra.opIndex !== undefined) this.opIndex = extra.opIndex;
    if (extra.currentVersion !== undefined) this.currentVersion = extra.currentVersion;
  }

  toBody(): ErrorBody {
    const body: ErrorBody = { code: this.code, message: this.message };
    if (this.opIndex !== undefined) body.opIndex = this.opIndex;
    if (this.currentVersion !== undefined) body.currentVersion = this.currentVersion;
    return body;
  }
}
