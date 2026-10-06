import { DemoScenarioScreen } from "@/components/demo/DemoScenarioScreen";

// S-29: the demo account's synthetic goal scenarios. It sits in the focus shell, like S-08 which it replaces for demo accounts; a visitor goes to the
// login screen and an account that is not a demo account goes to today.
export default function DemoScenarioPage() {
  return <DemoScenarioScreen />;
}
