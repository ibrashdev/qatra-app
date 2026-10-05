import { GameRoundScreen } from "@/components/games/GameRoundScreen";

// S-16 Word or segment choice (UI-screens Batch 3): a focus-flow round. The snapshot is held in memory by the hub, so a reload goes back to the games.
export default function WordChoicePage() {
  return <GameRoundScreen gameType="word_choice" />;
}
