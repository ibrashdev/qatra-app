import { GameRoundScreen } from "@/components/games/GameRoundScreen";

// S-15 Word order (UI-screens Batch 3): a focus-flow round. The snapshot is held in memory by the hub, so a reload goes back to the games.
export default function WordOrderPage() {
  return <GameRoundScreen gameType="word_order" />;
}
