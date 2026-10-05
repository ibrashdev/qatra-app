"use client";

import { use } from "react";
import { PlanChatScreen } from "@/components/plan-chat/PlanChatScreen";

// S-34 (UI-design route 5a). `params` is a promise in this Next.js version, read with `use` in a client page.
export default function PlanChatPage({ params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = use(params);
  return <PlanChatScreen chatId={chatId} />;
}
