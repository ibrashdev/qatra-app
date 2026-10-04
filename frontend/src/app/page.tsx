import { redirect } from "next/navigation";

// The public catalog ships in Batch 2; until then / leads to the login placeholder (UI-design 8).
export default function HomePage(): never {
  redirect("/login");
}
