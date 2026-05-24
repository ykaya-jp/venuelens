"use client";

import { useState, useTransition } from "react";
import { CalendarPlus, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { updateWeddingDate } from "@/server/actions/decisions";

/**
 * Track C-2 wedding-date input — client-side affordance for the
 * countdown card.
 *
 * Two visual modes:
 *   - `mode="cta"`   — full-width primary button that expands inline to
 *                       a date picker (no-date state)
 *   - `mode="edit"`  — small "変更" link surfacing the same picker
 *                       (already-set state)
 *
 * The picker uses native <input type="date"> which gives iOS / Android
 * the OS-level wheel selector for free. The string handed to the server
 * action is verbatim YYYY-MM-DD — same shape the action's zod regex
 * expects. Optimistic UI is intentionally absent: the parent re-renders
 * after `revalidatePath("/home")`, so we just show pending + toast.
 */
interface Props {
  mode: "cta" | "edit";
  initialDate: string | null;
}

export function WeddingDateSetter({ mode, initialDate }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string>(initialDate ?? defaultDraft());
  const [isPending, startTransition] = useTransition();

  function commit(date: string | null) {
    // Audit P1-22: wedding-date overwrites were silent before this —
    // both members could update the date with no confirmation, so a
    // partner could blindly stomp on a date the other had just set.
    // Confirm in the browser whenever there is already a date on file
    // (= initialDate non-null) so the second person to edit at least
    // sees what they're replacing. The server action itself stays
    // idempotent for clear (date=null) so the "未設定にする" flow doesn't
    // ask for confirmation.
    if (initialDate && date && date !== initialDate) {
      const ok =
        typeof window !== "undefined" &&
        window.confirm(
          `すでに ${initialDate} で残されています。 ${date} に変更しますか？`,
        );
      if (!ok) return;
    } else if (initialDate && date === null) {
      const ok =
        typeof window !== "undefined" &&
        window.confirm(`${initialDate} を未設定に戻しますか？`);
      if (!ok) return;
    }

    startTransition(async () => {
      try {
        const result = await updateWeddingDate({ date });
        if (!result.ok) throw new Error(result.error ?? "保存に失敗しました");
        setOpen(false);
        toast.success(date ? "晴れの日を残しました" : "晴れの日を未設定にしました");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "保存に失敗しました";
        toast.error(message);
      }
    });
  }

  if (!open) {
    if (mode === "cta") {
      return (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm transition-colors active:scale-[0.99]"
        >
          <CalendarPlus className="h-4 w-4" aria-hidden="true" />
          晴れの日を残す
        </button>
      );
    }
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 items-center gap-1 text-fluid-xs text-muted-foreground hover:text-foreground"
      >
        <Pencil className="h-3 w-3" aria-hidden="true" />
        変更
      </button>
    );
  }

  return (
    <div className="space-y-2.5">
      <label className="block text-fluid-xs text-muted-foreground" htmlFor="wedding-date-input">
        晴れの日
      </label>
      <input
        id="wedding-date-input"
        type="date"
        value={draft}
        min={todayInputValue()}
        onChange={(e) => setDraft(e.currentTarget.value)}
        disabled={isPending}
        className={cn(
          "block min-h-11 w-full rounded-xl border border-border bg-card px-3 text-sm tabular-nums text-foreground",
          isPending && "opacity-60",
        )}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => commit(draft || null)}
          disabled={isPending || !/^\d{4}-\d{2}-\d{2}$/.test(draft)}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors active:scale-[0.99] disabled:opacity-50"
        >
          {isPending ? "保存中…" : "残す"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={isPending}
          className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-border bg-background px-4 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden="true" />
          やめる
        </button>
      </div>
      {initialDate ? (
        <button
          type="button"
          onClick={() => commit(null)}
          disabled={isPending}
          className="inline-flex min-h-11 items-center gap-1 self-start text-fluid-xs text-muted-foreground hover:text-foreground"
        >
          晴れの日を未設定にする
        </button>
      ) : null}
    </div>
  );
}

/**
 * Default the picker to one year out — typical wedding planning lead
 * time, lets the user adjust rather than scroll up from today.
 */
function defaultDraft(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return toInputValue(d);
}

function todayInputValue(): string {
  return toInputValue(new Date());
}

function toInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
