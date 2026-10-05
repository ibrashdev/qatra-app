// Mock handlers for E05, E06, E07 and E10, as the recovery screen (S-05) and the re-consent gate (S-06) use them. Synthetic data only: the codes,
// grants and names below belong to no account. Registered by the coordinator over the shared set: { ...mockHandlers, ...accountMockHandlers }.
//
// Two keys of the shared set are wrapped on purpose (GET /me and POST /auth/login), so that a login that asks for consent leaves a profile with an old
// terms version until E05 answers: without that the re-consent gate could never be reached in mock mode. handlers.ts must not import this file
// (this one reads its values); mockHandlers is looked up when a request arrives, not when the module loads.
import { passwordViolations } from "@/lib/auth/account-rules";
import { normalizeRecoveryCode } from "../account-endpoints";
import type { Profile } from "../types";
import { MOCK_RECOVERY_CODE, MOCK_TERMS_VERSION, mockProfile } from "./fixtures";
import { errorResponse, mockHandlers, type MockHandler, type MockRequest, type MockResponse, type MockScenario } from "./handlers";

// The replacement code E07 answers with: the example of API-spec 4.2, synthetic, never a real code.
export const MOCK_REPLACEMENT_CODE = "fedc-ba98-7654-3210-fedc-ba98-7654-3210";

// The terms version a learner holds until E05 answers, once a login has asked for consent.
export const MOCK_OLD_TERMS_VERSION = "2026-01-01";

// The names E06 answers for with the example code. Any other name, or a wrong code, is the generic invalid_credentials (G-04).
const RECOVERABLE_NAMES = ["sample_user_01", "new_user_01", "reconsent_user_01"] as const;

// Names that make E06 answer each failure of API-spec 4.2, whatever the code is.
export type MockRecoveryVerifyOutcome = "throttled" | "locked" | "unavailable" | "internal" | "origin" | "silent";

export const MOCK_RECOVERY_VERIFY: ReadonlyMap<string, MockRecoveryVerifyOutcome> = new Map<string, MockRecoveryVerifyOutcome>([
  ["throttled_user_01", "throttled"],
  ["locked_user_01", "locked"],
  ["unavailable_user_01", "unavailable"],
  ["internal_user_01", "internal"],
  ["origin_user_01", "origin"],
  ["silent_user_01", "silent"],
]);

// Names that pass E06 with the example code and then make E07 answer each failure: `expired` is a grant that lapsed, `silent` is no answer at all
// (the uncertain outcome of P-10, the new password may or may not have been set).
export type MockRecoveryResetOutcome = "expired" | "throttled" | "unavailable" | "internal" | "origin" | "silent";

export const MOCK_RECOVERY_RESET: ReadonlyMap<string, MockRecoveryResetOutcome> = new Map<string, MockRecoveryResetOutcome>([
  ["reset_expired_user_01", "expired"],
  ["reset_throttled_user_01", "throttled"],
  ["reset_unavailable_user_01", "unavailable"],
  ["reset_internal_user_01", "internal"],
  ["reset_origin_user_01", "origin"],
  ["reset_silent_user_01", "silent"],
]);

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

// E06 and E04 normalise the name alike: NFKC, Latin letters lowercased, nothing else folded.
const normalizeUsername = (name: string): string => name.normalize("NFKC").toLowerCase();

const unauthenticated = (): MockResponse => errorResponse(401, "unauthenticated", "Authentication is required.");
const invalidCredentials = (): MockResponse => errorResponse(401, "invalid_credentials", "The recovery details are not correct.");

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

// The grants of one mock session: issued by E06, spent by a successful E07.
interface GrantStore {
  issued: Map<string, string>; // grant -> normalised username
  spent: Set<string>;
  counter: number;
}

const grantStores = new WeakMap<MockScenario, GrantStore>();

function grantsOf(scenario: MockScenario): GrantStore {
  let store = grantStores.get(scenario);
  if (store === undefined) {
    store = { issued: new Map(), spent: new Set(), counter: 0 };
    grantStores.set(scenario, store);
  }
  return store;
}

function throttledAnswer(outcome: "throttled" | "locked"): MockResponse {
  return errorResponse(429, "throttled", "Too many attempts.", { retryAfterSec: outcome === "locked" ? 900 : 20 });
}

// E06 answers in the order of API-spec 4.2: the schema, the throttle and the outages, then the credentials. A malformed code is the same generic 401.
const verifyRecovery: MockHandler = ({ body }, scenario) => {
  const fields = asRecord(body);
  const broken = schemaErrors(fields, ["username", "recoveryCode"]);
  if (broken.length > 0) return validationError(broken);

  const username = normalizeUsername(fields.username as string);
  switch (MOCK_RECOVERY_VERIFY.get(username)) {
    case "origin":
      return errorResponse(403, "forbidden_origin", "The request origin is not allowed.");
    case "throttled":
      return throttledAnswer("throttled");
    case "locked":
      return throttledAnswer("locked");
    case "unavailable":
      return errorResponse(503, "unavailable", "The service is temporarily unavailable.");
    case "internal":
      return errorResponse(500, "internal", "Unexpected error.");
    case "silent":
      // No answer at all: the connection fails.
      throw new TypeError("The mock connection failed.");
  }

  const known = (RECOVERABLE_NAMES as readonly string[]).includes(username) || MOCK_RECOVERY_RESET.has(username);
  const code = normalizeRecoveryCode(fields.recoveryCode as string);
  if (!known || code === null || code !== normalizeRecoveryCode(MOCK_RECOVERY_CODE)) return invalidCredentials();

  const store = grantsOf(scenario);
  store.counter += 1;
  const grant = `mock-grant-${store.counter}`;
  store.issued.set(grant, username);
  return { status: 200, body: { resetGrant: grant, expiresInSec: 600 } };
};

// E07: the grant first (unknown, spent or lapsed is the generic 401), then the password policy, then the outcomes that depend on the server.
const resetPassword: MockHandler = ({ body }, scenario) => {
  const fields = asRecord(body);
  const broken = schemaErrors(fields, ["resetGrant", "newPassword"]);
  if (broken.length > 0) return validationError(broken);

  const store = grantsOf(scenario);
  const grant = fields.resetGrant as string;
  const username = store.issued.get(grant);
  const outcome = username === undefined ? undefined : MOCK_RECOVERY_RESET.get(username);
  if (username === undefined || store.spent.has(grant) || outcome === "expired") return invalidCredentials();

  const rules = passwordViolations(fields.newPassword as string);
  if (rules.length > 0) return validationError(rules.map((rule) => ({ field: "newPassword", rule })));

  switch (outcome) {
    case "origin":
      return errorResponse(403, "forbidden_origin", "The request origin is not allowed.");
    case "throttled":
      return throttledAnswer("throttled");
    case "unavailable":
      return errorResponse(503, "unavailable", "The service is temporarily unavailable.");
    case "internal":
      return errorResponse(500, "internal", "Unexpected error.");
    case "silent":
      throw new TypeError("The mock connection failed.");
  }

  store.spent.add(grant);
  // E07 creates no session and revokes every other one: the learner always logs in again.
  scenario.signedIn = false;
  return { status: 200, body: { recoveryCode: MOCK_REPLACEMENT_CODE } };
};

// A scenario that also remembers that the learner's terms are out of date: set by a login that asks for consent, cleared by E05 and by E10.
type ConsentScenario = MockScenario & { termsPending?: boolean };

function sharedHandler(key: string): MockHandler {
  const handler = mockHandlers[key];
  if (handler === undefined) throw new Error(`The shared mock set has no handler for ${key}.`);
  return handler;
}

function profileFor(scenario: MockScenario, termsVersion: string): Profile {
  return { ...mockProfile, isDemo: scenario.isDemo === true, termsVersion };
}

// E05 answers in the order of API-spec 4.2: the session, the schema, then the version.
const acceptTerms: MockHandler = ({ body }, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  const broken = schemaErrors(asRecord(body), ["termsVersion"]);
  if (broken.length > 0) return validationError(broken);
  if (asRecord(body).termsVersion !== MOCK_TERMS_VERSION) {
    return errorResponse(400, "terms_required", "The current terms must be accepted.", { requiredVersion: MOCK_TERMS_VERSION });
  }
  (scenario as ConsentScenario).termsPending = false;
  return { status: 200, body: { profile: profileFor(scenario, MOCK_TERMS_VERSION) } };
};

// E10 is tolerant: with or without a session it answers 204 and the session is gone.
const logout: MockHandler = (_request, scenario) => {
  scenario.signedIn = false;
  (scenario as ConsentScenario).termsPending = false;
  return { status: 204 };
};

// The login that asks for consent leaves the learner holding the old terms version, so that E11 tells S-06 the change is pending.
const loginWithPendingTerms: MockHandler = (request: MockRequest, scenario) => {
  const answer = sharedHandler("POST /auth/login")(request, scenario);
  if (answer.status === 200 && asRecord(answer.body).reconsentRequired === true) (scenario as ConsentScenario).termsPending = true;
  return answer;
};

const profileWithPendingTerms: MockHandler = (request, scenario) => {
  const answer = sharedHandler("GET /me")(request, scenario);
  if (answer.status !== 200 || (scenario as ConsentScenario).termsPending !== true) return answer;
  return { status: 200, body: { ...asRecord(answer.body), termsVersion: MOCK_OLD_TERMS_VERSION } };
};

// Keys are "METHOD /path", like mockHandlers. The last two replace the shared ones of the same key and call them.
export const accountMockHandlers: Readonly<Record<string, MockHandler>> = {
  "POST /auth/recovery/verify": verifyRecovery,
  "POST /auth/recovery/reset": resetPassword,
  "POST /auth/consent": acceptTerms,
  "POST /auth/logout": logout,
  "POST /auth/login": loginWithPendingTerms,
  "GET /me": profileWithPendingTerms,
};
