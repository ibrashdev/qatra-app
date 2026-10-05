// Mock handlers for the account screens S-23, S-24 and S-27 (E09 POST /auth/password, E08 POST /auth/recovery/rotate, E13 POST /account/delete).
// Synthetic data only. Registered by the coordinator over the shared set in mock-fetch.ts, after settingsMockHandlers.
// handlers.ts must not import this file. To wrap a key of an earlier set, read it from that set when a request arrives, not when the module loads.
//
// The current password is MOCK_PASSWORD; any other is the generic 401 invalid_credentials (G-04). The mock session has one name, so the failures that
// depend on the server are reached by typing one of the trigger passwords below as the current password. They answer the same whatever else is sent.
import { passwordViolations } from "@/lib/auth/account-rules";
import { MOCK_PASSWORD, mockProfile } from "./fixtures";
import { errorResponse, type MockHandler, type MockResponse, type MockScenario } from "./handlers";

// The replacement code E08 answers with: the example of API-spec 4.2, synthetic, never a real code.
export const MOCK_ROTATED_CODE = "89ab-cdef-0123-4567-89ab-cdef-0123-4567";

export type MockSecurityOutcome = "throttled" | "locked" | "unavailable" | "internal" | "origin" | "silent";

// Current passwords that make E08, E09 and E13 answer each failure of API-spec 4.2. `silent` is no answer at all (the uncertain outcome of P-10).
export const MOCK_SECURITY_OUTCOMES: ReadonlyMap<string, MockSecurityOutcome> = new Map<string, MockSecurityOutcome>([
  ["mock outcome: throttled", "throttled"],
  ["mock outcome: locked", "locked"],
  ["mock outcome: unavailable", "unavailable"],
  ["mock outcome: internal", "internal"],
  ["mock outcome: origin", "origin"],
  ["mock outcome: silent", "silent"],
]);

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

const unauthenticated = (): MockResponse => errorResponse(401, "unauthenticated", "Authentication is required.");
const invalidCredentials = (): MockResponse => errorResponse(401, "invalid_credentials", "The password is not correct.");

function validationError(fields: { field: string; rule: string }[]): MockResponse {
  return errorResponse(422, "validation_error", "The request body is not valid.", { fields });
}

// The fields a body must have, no more: a missing or mistyped one, then an unknown one, as the other mock handlers report them.
function schemaErrors(fields: Record<string, unknown>, allowed: readonly string[]): { field: string; rule: string }[] {
  return [
    ...allowed.filter((field) => typeof fields[field] !== "string").map((field) => ({ field, rule: "invalid_type" })),
    ...Object.keys(fields)
      .filter((field) => !allowed.includes(field))
      .map((field) => ({ field, rule: "forbidden_field" })),
  ];
}

// The failures that depend on the server, picked by the password that was sent as the current one.
function outcomeAnswer(password: string): MockResponse | null {
  switch (MOCK_SECURITY_OUTCOMES.get(password)) {
    case "origin":
      return errorResponse(403, "forbidden_origin", "The request origin is not allowed.");
    case "throttled":
      return errorResponse(429, "throttled", "Too many attempts.", { retryAfterSec: 20 });
    case "locked":
      return errorResponse(429, "throttled", "Too many attempts.", { retryAfterSec: 900 });
    case "unavailable":
      return errorResponse(503, "unavailable", "The service is temporarily unavailable.");
    case "internal":
      return errorResponse(500, "internal", "Unexpected error.");
    case "silent":
      // No answer at all: the connection fails, as when a response is lost after the commit.
      throw new TypeError("The mock connection failed.");
  }
  return null;
}

// The order of API-spec 4.2: the session, the schema, the outages and the throttle, then the current password.
function checkCurrentPassword(scenario: MockScenario, fields: Record<string, unknown>, allowed: readonly string[], passwordField: string): MockResponse | null {
  if (!scenario.signedIn) return unauthenticated();
  const broken = schemaErrors(fields, allowed);
  if (broken.length > 0) return validationError(broken);
  const password = fields[passwordField] as string;
  return outcomeAnswer(password) ?? (password === MOCK_PASSWORD ? null : invalidCredentials());
}

// E09: 200 with the profile (the real server also sets a fresh cookie, which this layer has no cookie for), after the password policy of E03.
const changePassword: MockHandler = ({ body }, scenario) => {
  const fields = asRecord(body);
  const refused = checkCurrentPassword(scenario, fields, ["currentPassword", "newPassword"], "currentPassword");
  if (refused !== null) return refused;
  const rules = passwordViolations(fields.newPassword as string);
  if (rules.length > 0) return validationError(rules.map((rule) => ({ field: "newPassword", rule })));
  return { status: 200, body: { profile: { ...mockProfile, isDemo: scenario.isDemo === true } } };
};

// E08: 200 with the replacement code, 32 hexadecimal characters in eight groups of four.
const rotateRecovery: MockHandler = ({ body }, scenario) => {
  const refused = checkCurrentPassword(scenario, asRecord(body), ["password"], "password");
  return refused ?? { status: 200, body: { recoveryCode: MOCK_ROTATED_CODE } };
};

// E13: the password first, then the literal. 204 ends the mock session, so a repeat answers 401 like the real server.
const deleteAccount: MockHandler = ({ body }, scenario) => {
  const fields = asRecord(body);
  const refused = checkCurrentPassword(scenario, fields, ["password", "confirm"], "password");
  if (refused !== null) return refused;
  if (fields.confirm !== "DELETE") return validationError([{ field: "confirm", rule: "confirm_literal" }]);
  scenario.signedIn = false;
  return { status: 204 };
};

// Keys are "METHOD /path", like mockHandlers.
export const securityMockHandlers: Readonly<Record<string, MockHandler>> = {
  "POST /auth/recovery/rotate": rotateRecovery,
  "POST /auth/password": changePassword,
  "POST /account/delete": deleteAccount,
};
