import { getDb } from "@/db";
import { requireUser } from "@/lib/access";
import { listEntries } from "@/lib/allowlist/service";
import { LocalDate } from "./local-date";
import { AddMemberForm, RemoveButton, RoleSelect } from "./member-controls";

export default async function AdminPage() {
  const me = await requireUser("admin");
  const entries = await listEntries(getDb());

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-black/10 dark:border-white/15">
            <th className="py-2 pr-4 font-medium">Email</th>
            <th className="py-2 pr-4 font-medium">Role</th>
            <th className="py-2 pr-4 font-medium">Invited by</th>
            <th className="py-2 pr-4 font-medium">Added</th>
            <th className="py-2 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.email} className="border-b border-black/5 align-top dark:border-white/10">
              <td className="py-3 pr-4">{entry.email}</td>
              <td className="py-3 pr-4">
                <RoleSelect email={entry.email} role={entry.role} />
              </td>
              <td className="py-3 pr-4">{entry.invitedBy ?? "-"}</td>
              <td className="py-3 pr-4"><LocalDate iso={entry.createdAt.toISOString()} /></td>
              <td className="py-3">{entry.email !== me.email && <RemoveButton email={entry.email} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <AddMemberForm />
    </main>
  );
}
