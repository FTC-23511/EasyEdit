"use client";

import { useRef, useState, useTransition } from "react";
import { addMemberAction, removeMemberAction, setRoleAction } from "./actions";

type ActionResult = { error?: string };

function useAction(action: (formData: FormData) => Promise<ActionResult>) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  function submit(formData: FormData, onSuccess?: () => void) {
    startTransition(async () => {
      const result = await action(formData);
      setError(result.error ?? null);
      if (!result.error) onSuccess?.();
    });
  }
  return { error, pending, submit };
}

function ErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-red-700">
      {message}
    </p>
  );
}

const ROLE_OPTIONS = ["admin", "editor", "viewer"] as const;

export function RoleSelect({ email, role }: { email: string; role: string }) {
  const { error, pending, submit } = useAction(setRoleAction);
  return (
    <div className="flex flex-col gap-1">
      <select
        aria-label={`Role for ${email}`}
        defaultValue={role}
        disabled={pending}
        onChange={(e) => {
          const formData = new FormData();
          formData.set("email", email);
          formData.set("role", e.target.value);
          submit(formData);
        }}
        className="rounded-md border border-black/15 bg-background px-2 py-1 text-sm disabled:opacity-60 dark:border-white/20"
      >
        {ROLE_OPTIONS.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <ErrorText message={error} />
    </div>
  );
}

export function RemoveButton({ email }: { email: string }) {
  const { error, pending, submit } = useAction(removeMemberAction);
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          const formData = new FormData();
          formData.set("email", email);
          submit(formData);
        }}
        className="rounded-md border border-red-300 px-2 py-1 text-sm text-red-700 disabled:opacity-60"
      >
        Remove
      </button>
      <ErrorText message={error} />
    </div>
  );
}

export function AddMemberForm() {
  const { error, pending, submit } = useAction(addMemberAction);
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        submit(new FormData(e.currentTarget), () => formRef.current?.reset());
      }}
      className="flex flex-col gap-3"
    >
      <h2 className="text-lg font-semibold">Add member</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            name="email"
            type="email"
            required
            className="w-72 rounded-md border border-black/15 bg-background px-3 py-2 dark:border-white/20"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Role
          <select
            name="role"
            defaultValue="editor"
            className="rounded-md border border-black/15 bg-background px-3 py-2 dark:border-white/20"
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-foreground px-5 py-2 font-medium text-background disabled:opacity-60"
        >
          Add member
        </button>
      </div>
      <ErrorText message={error} />
    </form>
  );
}
