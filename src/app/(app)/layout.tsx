import Link from "next/link";
import { KeepSignedIn } from "@/components/keep-signed-in";
import { requireUser } from "@/lib/access";
import { SignOutButton } from "./sign-out-button";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();

  return (
    <>
      <header className="flex items-center gap-6 border-b border-black/10 px-6 py-3 dark:border-white/15">
        <span className="font-semibold">EasyEdit</span>
        <nav className="flex flex-1 items-center gap-4 text-sm">
          <Link href="/dashboard">Dashboard</Link>
          {user.role === "admin" && <Link href="/admin">Admin</Link>}
        </nav>
        <div className="flex items-center gap-3 text-sm">
          {user.image && (
            // eslint-disable-next-line @next/next/no-img-element -- Google avatar from an arbitrary host; next/image would need a remote pattern.
            <img src={user.image} alt="" width={28} height={28} referrerPolicy="no-referrer" className="rounded-full" />
          )}
          <span>{user.email}</span>
          <SignOutButton />
        </div>
      </header>
      <KeepSignedIn />
      {children}
    </>
  );
}
