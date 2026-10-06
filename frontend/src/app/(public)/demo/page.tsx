import { DemoEntryScreen } from "@/components/demo/DemoEntryScreen";

// S-28 (option C, package F12): the public demo link of the committee journey. The screen builds its own header like S-02; guard 2 sends a signed-in
// visitor on.
export default function DemoPage() {
  return <DemoEntryScreen />;
}
