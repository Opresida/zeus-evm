import { Signup } from "@/components/auth/Signup";

export const dynamic = "force-dynamic";

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  const sp = await searchParams;
  return <Signup invite={(sp?.invite ?? "").trim()} />;
}
