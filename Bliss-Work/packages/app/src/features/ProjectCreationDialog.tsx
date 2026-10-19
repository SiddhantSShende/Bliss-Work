/**
 * "+ New" project (Section 6.4): a dedicated, standalone way to create a
 * project — a name plus one or more existing channels — with no task
 * involved. POST /api/v1/projects does the real validation (every channel
 * needs >=2 real members); this dialog also checks memberCount up front, at
 * the moment a channel is picked, so a bad pick is rejected immediately
 * rather than only at submit.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Hash, Search } from "lucide-react";
import { Button, Input } from "@taskboard/ui";
import { toast } from "sonner";
import type { ChannelDTO, ProjectDTO } from "@taskboard/shared";
import { useRuntime } from "../lib/runtime";
import { qk } from "../lib/queryBridge";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { usePagedPicker } from "../lib/usePagedPicker";
import { Modal } from "./Modal";
import { Field } from "../routes/Onboarding";
import { PagedListBox } from "./PagedListBox";
import { Row, listCopy, pagedState, type ChannelPickLike } from "./AssignToPanel";

const SEARCH_DEBOUNCE_MS = 250;
const MIN_PROJECT_CHANNEL_MEMBERS = 2;
const matchesChannel = (c: ChannelDTO, q: string) => !q || c.name.toLowerCase().includes(q.toLowerCase());

export function ProjectCreationDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Fires once, after the project is actually created, with the new
   *  project — so a caller that opened this FOR a task (the task dialog's
   *  "+ New") can select it immediately. Omitted, nothing extra happens. */
  onCreated?: (project: ProjectDTO) => void;
}) {
  const { t } = useTranslation("tasks");
  const { api } = useRuntime();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [selectedChannels, setSelectedChannels] = useState<Map<string, ChannelPickLike>>(new Map());
  const formId = useId();
  const inFlight = useRef(false);

  useEffect(() => {
    if (open) {
      setName("");
      setQuery("");
      setSelectedChannels(new Map());
    }
  }, [open]);

  const list = usePagedPicker<ChannelDTO>({
    cacheKey: "new-project-channels",
    query: useDebouncedValue(query, SEARCH_DEBOUNCE_MS),
    enabled: open,
    fetchPage: ({ q, offset, limit }) => api.channelsPage({ q, offset, limit }),
    matches: matchesChannel,
  });

  const toggleChannel = (channel: ChannelDTO) => {
    if (selectedChannels.has(channel.id)) {
      setSelectedChannels((s) => {
        const next = new Map(s);
        next.delete(channel.id);
        return next;
      });
      return;
    }
    if (channel.memberCount < MIN_PROJECT_CHANNEL_MEMBERS) {
      toast.error(t("projectCreationDialog.errors.channelTooSmall", { name: channel.name }));
      return;
    }
    setSelectedChannels((s) => new Map(s).set(channel.id, { id: channel.id, name: channel.name, memberCount: channel.memberCount }));
  };

  const create = useMutation({
    mutationFn: () => api.createProject(name.trim(), [...selectedChannels.keys()]),
    onSuccess: (project) => {
      toast.success(t("projectCreationDialog.toasts.created", { name: project.name }));
      qc.invalidateQueries({ queryKey: qk.projects });
      onCreated?.(project);
      onClose();
    },
    onError: (e) => toast.error(t("projectCreationDialog.errors.createFailed"), { description: String(e) }),
    onSettled: () => {
      inFlight.current = false;
    },
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    if (!name.trim()) return toast.error(t("projectCreationDialog.errors.needName"));
    if (selectedChannels.size === 0) return toast.error(t("projectCreationDialog.errors.needChannel"));
    inFlight.current = true;
    create.mutate();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("projectCreationDialog.title")}
      showClose
      footer={
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("projectCreationDialog.actions.cancel")}
          </Button>
          <Button type="submit" form={formId} loading={create.isPending}>
            {create.isPending ? t("projectCreationDialog.actions.creating") : t("projectCreationDialog.actions.create")}
          </Button>
        </div>
      }
    >
      <form id={formId} onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-3.5">
        <Field label={t("projectCreationDialog.fields.name")}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={200}
            placeholder={t("projectCreationDialog.fields.namePlaceholder")}
            autoFocus
          />
        </Field>

        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <span className="text-sm font-medium text-fg">
            {t("projectCreationDialog.fields.channels")}
            <span className="ml-1 text-xs font-normal text-muted">
              ({t("createTaskDialog.assign.members", { count: selectedChannels.size })})
            </span>
          </span>
          <div className="relative">
            <Search size={16} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
              placeholder={t("createTaskDialog.assign.channelsSearch")}
              aria-label={t("createTaskDialog.assign.channelsSearchLabel")}
              maxLength={100}
              className="h-9 w-full rounded-xl border border-border bg-surface-2 pl-9 pr-3 text-sm text-fg placeholder:text-muted focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25"
            />
          </div>
          <PagedListBox
            label={t("projectCreationDialog.fields.channelsListLabel")}
            note={t("projectCreationDialog.fields.channelsHint")}
            count={list.items.length}
            {...pagedState(list)}
            copy={listCopy(t, "channels")}
          >
            {list.items.map((c) => (
              <Row key={c.id} checked={selectedChannels.has(c.id)} onToggle={() => toggleChannel(c)}>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-from/15 to-brand-to/15 text-accent">
                  <Hash size={16} aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{c.name}</span>
                <span className="shrink-0 text-xs text-muted">{t("createTaskDialog.assign.members", { count: c.memberCount })}</span>
              </Row>
            ))}
          </PagedListBox>
        </div>
      </form>
    </Modal>
  );
}
