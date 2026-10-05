import { GameRoundScreen } from "@/components/games/GameRoundScreen";

// S-18 Word recall (UI-screens Batch 3): a focus-flow round. The snapshot is held in memory by the hub, so a reload goes back to the games.
export default function WordRecallPage() {
  return <GameRoundScreen gameType="word_recall" />;
}
