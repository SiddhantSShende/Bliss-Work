/**
 * Allocator's review of a COMPLETED assignment (text + optional 1–5 stars).
 * Editable — re-submitting overwrites. The assignee sees it live via the
 * task.reviewed event.
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Star } from "lucide-react";
import { Button, Textarea } from "@taskboard/ui";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { Modal } from "./Modal";

export function CreateReviewDialog({
  open,
  onClose,
  taskId,
  assigneeId,
  assigneeName,
  existingText,
  existingRating,
}: {
  open: boolean;
  onClose: () => void;
  taskId: string;
  assigneeId: string;
  assigneeName: string;
  existingText?: string | null;
  existingRating?: number | null;
}) {
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [rating, setRating] = useState<number | null>(null);

  // Seed from any existing review whenever the dialog opens (edit flow).
  useEffect(() => {
    if (open) {
      setText(existingText ?? "");
      setRating(existingRating ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = useMutation({
    mutationFn: () =>
      api.reviewTask(taskId, assigneeId, { text: text.trim(), rating: rating ?? undefined }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.sent });
      toast.success("Review saved");
      onClose();
    },
    onError: (e) => toast.error("Couldn't save review", { description: String(e) }),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return toast.error("Write a short review first");
    save.mutate();
  };

  return (
    <Modal open={open} onClose={onClose} title={`Review ${assigneeName}'s work`}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div>
          <div className="mb-1.5 text-sm font-medium text-fg">Rating (optional)</div>
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setRating((r) => (r === n ? null : n))}
                title={`${n} star${n === 1 ? "" : "s"}`}
                className="rounded p-0.5 text-muted transition hover:text-amber-400"
              >
                <Star
                  size={22}
                  className={rating && n <= rating ? "fill-amber-400 text-amber-400" : ""}
                />
              </button>
            ))}
            {rating != null && (
              <button
                type="button"
                onClick={() => setRating(null)}
                className="ml-2 text-xs text-muted hover:text-fg"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <div>
          <div className="mb-1.5 text-sm font-medium text-fg">Feedback</div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={4000}
            required
            placeholder="How did they do?"
          />
        </div>

        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending}>
            {save.isPending ? "Saving…" : "Save review"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
