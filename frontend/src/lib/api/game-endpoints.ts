import type { ApiClient, RequestOptions } from "./client";
import { startSession, type GameSessionBody } from "./session-endpoints";
import type { GameKind, SessionSnapshot } from "./types";

// E20 `game` as the games hub (S-14) and «العب مرة أخرى» (P-25) use it. E21 and E22 of a round are the calls of session-endpoints.ts.

export interface StartGameRoundRequest {
  planId: string;
  planVersion: number;
  gameType: GameKind;
}

// UG-03: no `passageIds`. The server samples inside the plan's scope, edition and selected paths (future days included, D42).
export const gameSessionBody = ({ planId, planVersion, gameType }: StartGameRoundRequest): GameSessionBody => ({
  kind: "game",
  planId,
  expectedPlanVersion: planVersion,
  gameType,
});

// A call that creates a row, so it is never retried automatically (P-14, P-19).
export function startGameRound(client: ApiClient, request: StartGameRoundRequest, options?: Pick<RequestOptions, "signal">): Promise<SessionSnapshot> {
  return startSession(client, gameSessionBody(request), options);
}
