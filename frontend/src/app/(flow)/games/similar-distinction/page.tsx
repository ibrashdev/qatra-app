import { GameRoundScreen } from "@/components/games/GameRoundScreen";

// S-17 Similar distinction (UI-screens Batch 3): a focus-flow round. The snapshot is held in memory by the hub, so a reload goes back to the games.
export default function SimilarDistinctionPage() {
  return <GameRoundScreen gameType="similar_distinction" />;
}
