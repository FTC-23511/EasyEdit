export const UNAUTHENTICATED_BODY = { code: "UNAUTHENTICATED", message: "Sign in to continue." } as const;
export const FORBIDDEN_BODY = { code: "FORBIDDEN", message: "Your role doesn't allow this." } as const;
export const INTERNAL_BODY = { code: "INTERNAL", message: "Something went wrong. Try again." } as const;
export const CROSS_ORIGIN_BODY = { code: "FORBIDDEN", message: "This request came from another site." } as const;
