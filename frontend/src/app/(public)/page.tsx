import { CatalogScreen } from "@/components/catalog/CatalogScreen";

// S-07 at / for visitors. The screen builds its own public shell (header actions, wake-up line in the page); guard 2 sends a signed-in learner on.
export default function HomePage() {
  return <CatalogScreen />;
}
