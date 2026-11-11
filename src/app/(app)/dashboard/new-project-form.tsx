"use client";

import { useActionState } from "react";
import { FORMAT_PRESETS } from "@/lib/timeline";
import { LIMITS } from "@/lib/limits";
import { ErrorText } from "../action-ui";
import { createProjectAction } from "./actions";

export function NewProjectForm() {
  const [state, formAction, pending] = useActionState(createProjectAction, {});
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            name="name"
            required
            maxLength={LIMITS.projectNameChars}
            className="rounded border border-black/20 bg-transparent px-3 py-2 dark:border-white/25"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Format
          <select
            name="format"
            defaultValue="short_9x16"
            className="rounded border border-black/20 bg-transparent px-3 py-2 dark:border-white/25"
          >
            {Object.entries(FORMAT_PRESETS).map(([id, preset]) => (
              <option key={id} value={id}>
                {preset.label} ({preset.width}×{preset.height})
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-60"
        >
          New project
        </button>
      </div>
      <ErrorText message={state.error ?? null} />
    </form>
  );
}
