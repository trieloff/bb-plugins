// The settings page of bb's concurrency-limit plugin (plugins/concurrency-
// limit/app.tsx at desktop-v0.46.1), on this plugin's RPC client, with a line
// on what pinning changes and a section for load limits.
import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRealtime } from "@get-bb/plugin-sdk/app";
import { Input } from "../../components/ui/input.tsx";
import {
  CONFIGURATION_CHANGED_CHANNEL,
  type ConfigurationInput,
  type ConfigurationView,
} from "../shared/configuration.ts";
import {
  commitGlobalLimitDraft,
  commitHostLimitDraft,
  MAX_LIMIT_VALUE,
  type LimitDraftCommit,
} from "../shared/limits.ts";
import { LOAD_SAMPLE_MS, parsePercent, type LoadLimits } from "../shared/load.ts";
import { rpc } from "./rpc.ts";

type SaveState = "idle" | "saving" | "saved" | "error";

const GLOBAL_FIELD = "global";
const LOAD_FIELDS = {
  cpu: { field: "load-cpu", key: "cpuBusyPercent" },
  memory: { field: "load-memory", key: "memoryFreePercent" },
} as const satisfies Record<string, { field: string; key: keyof LoadLimits }>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function draftsFor(view: ConfigurationView): Record<string, string> {
  const drafts: Record<string, string> = {
    [GLOBAL_FIELD]: view.globalLimit === null ? "" : String(view.globalLimit),
  };
  for (const { field, key } of Object.values(LOAD_FIELDS)) {
    const limit = view.loadLimits?.[key] ?? null;
    drafts[field] = limit === null ? "" : String(limit);
  }
  for (const host of view.hosts) {
    drafts[host.id] = host.override === null ? "" : String(host.override);
  }
  return drafts;
}

function ThreadLimitSettings() {
  const client = rpc.useClient();
  const [view, setView] = useState<ConfigurationView | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const activeRef = useRef(true);
  const savingRef = useRef(false);

  const applyView = useCallback((next: ConfigurationView) => {
    setView(next);
    setDrafts(draftsFor(next));
  }, []);

  const refetch = useCallback(() => {
    if (savingRef.current) return;
    void client.getConfiguration().then(
      (configuration) => {
        if (!activeRef.current || savingRef.current) return;
        applyView(configuration);
        setError(null);
        setSaveState("saved");
      },
      (loadError: unknown) => {
        if (!activeRef.current) return;
        setError(errorMessage(loadError));
        setSaveState("error");
      },
    );
  }, [applyView, client]);

  useEffect(() => {
    activeRef.current = true;
    refetch();
    return () => {
      activeRef.current = false;
    };
  }, [refetch]);
  useRealtime(CONFIGURATION_CHANGED_CHANNEL, refetch);

  async function save(next: ConfigurationInput): Promise<void> {
    savingRef.current = true;
    setSaveState("saving");
    setError(null);
    try {
      const saved = await client.setConfiguration(next);
      if (!activeRef.current) return;
      applyView(saved);
      setSaveState("saved");
    } catch (saveError) {
      if (!activeRef.current) return;
      setError(errorMessage(saveError));
      setSaveState("error");
    } finally {
      savingRef.current = false;
    }
  }

  function changeDraft(field: string, value: string): void {
    setDrafts((current) => ({ ...current, [field]: value }));
    if (invalidField === field) setInvalidField(null);
  }

  function applyCommit(field: string, commit: LimitDraftCommit): void {
    if (commit.kind === "invalid") {
      setInvalidField(field);
      return;
    }
    if (commit.kind === "changed") void save(commit.configuration);
  }

  function commitGlobal(): void {
    if (view === null) return;
    applyCommit(GLOBAL_FIELD, commitGlobalLimitDraft(view, drafts[GLOBAL_FIELD] ?? ""));
  }

  function commitHost(hostId: string): void {
    if (view === null) return;
    applyCommit(hostId, commitHostLimitDraft(view, hostId, drafts[hostId] ?? ""));
  }

  function commitLoad({ field, key }: (typeof LOAD_FIELDS)[keyof typeof LOAD_FIELDS]): void {
    if (view === null) return;
    const value = parsePercent(drafts[field] ?? "");
    if (value === undefined) {
      setInvalidField(field);
      return;
    }
    if (value === (view.loadLimits?.[key] ?? null)) return;
    void save({
      globalLimit: view.globalLimit,
      hostOverrides: view.hostOverrides,
      loadLimits: { ...view.loadLimits, [key]: value },
    });
  }

  if (view === null) {
    return (
      <p
        className={error === null ? "text-sm text-muted-foreground" : "text-sm text-destructive"}
        role={error === null ? "status" : "alert"}
      >
        {error ?? "Loading limits…"}
      </p>
    );
  }

  const disabled = saveState === "saving";
  const validationMessage =
    invalidField === LOAD_FIELDS.cpu.field || invalidField === LOAD_FIELDS.memory.field
      ? "Use a whole percent from 1 to 100, or leave blank to turn it off."
      : `Use a whole number from 0 to ${MAX_LIMIT_VALUE}, or leave blank.`;

  return (
    <div className="w-full space-y-5">
      <p className="pr-2 text-xs leading-relaxed text-muted-foreground">
        Pinned threads are never held. Their turns still count toward these limits.
      </p>
      <div className="flex items-start justify-between gap-6 pr-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">Overall limit</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Leave blank for no overall limit. Use 0 to pause new work.
          </p>
        </div>
        <Input
          aria-label="Overall thread limit"
          aria-invalid={invalidField === GLOBAL_FIELD}
          className="w-28 shrink-0"
          disabled={disabled}
          inputMode="numeric"
          max={MAX_LIMIT_VALUE}
          min={0}
          placeholder="Unlimited"
          step={1}
          type="number"
          value={drafts[GLOBAL_FIELD] ?? ""}
          onBlur={commitGlobal}
          onChange={(event) => changeDraft(GLOBAL_FIELD, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </div>

      <div className="space-y-3 border-t border-border/60 pt-4">
        <div className="pr-2">
          <h3 className="text-sm font-medium text-foreground">Load limits</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            A host also holds new turns while it is this busy, even with threads to spare. Each host
            is checked every {LOAD_SAMPLE_MS / 1000} seconds. Leave blank to turn a limit off.
          </p>
        </div>
        {(
          [
            [LOAD_FIELDS.cpu, "CPU busy at or above", "Hold new turns while CPU is this busy"],
            [
              LOAD_FIELDS.memory,
              "Memory free at or below",
              "Hold new turns while this little memory is free",
            ],
          ] as const
        ).map(([load, label, ariaLabel]) => (
          <div key={load.field} className="flex items-center justify-between gap-6 pr-2">
            <span className="text-xs text-muted-foreground">{label}</span>
            <div className="flex shrink-0 items-center gap-1.5">
              <Input
                aria-label={ariaLabel}
                aria-invalid={invalidField === load.field}
                className="w-20"
                disabled={disabled}
                inputMode="numeric"
                max={100}
                min={1}
                placeholder="Off"
                step={1}
                type="number"
                value={drafts[load.field] ?? ""}
                onBlur={() => commitLoad(load)}
                onChange={(event) => changeDraft(load.field, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-border/60 pt-4">
        <h3 className="text-sm font-medium text-foreground">Host limits</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Auto allows one thread per available processor.
        </p>

        <div className="ml-2 mt-2 border-l border-border/60 pl-2">
          {view.hosts.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">No hosts available.</p>
          ) : (
            <div className="space-y-1">
              {view.hosts.map((host) => (
                <div
                  key={host.id}
                  className="flex min-h-14 items-center gap-3 rounded-md px-2 py-2 hover:bg-accent/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{host.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {host.status === "disconnected"
                        ? host.availableParallelism === null
                          ? "Offline"
                          : `${host.availableParallelism} processors · Offline`
                        : host.availableParallelism === null
                          ? "Detecting processors…"
                          : `${host.availableParallelism} processors`}
                      {host.status === "connected" && host.load ? (
                        <>
                          {` · CPU ${Math.round(host.load.cpuBusyPercent)}%`}
                          {host.load.memoryFreePercent === null
                            ? null
                            : ` · ${Math.round(host.load.memoryFreePercent)}% memory free`}
                          {host.overloadedBy ? (
                            <span className="text-destructive-text"> · Holding new turns</span>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  </div>
                  <Input
                    aria-label={`${host.name} thread limit`}
                    aria-invalid={invalidField === host.id}
                    className="w-28 shrink-0"
                    disabled={disabled}
                    inputMode="numeric"
                    max={MAX_LIMIT_VALUE}
                    min={0}
                    placeholder={`Auto (${host.automaticLimit})`}
                    step={1}
                    type="number"
                    value={drafts[host.id] ?? ""}
                    onBlur={() => commitHost(host.id)}
                    onChange={(event) => changeDraft(host.id, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-5 justify-end" aria-live="polite">
        {invalidField !== null ? (
          <span className="text-xs text-destructive" role="alert">
            {validationMessage}
          </span>
        ) : error !== null ? (
          <span className="text-xs text-destructive" role="alert">
            {error}
          </span>
        ) : (
          <output className="text-xs text-muted-foreground">
            {saveState === "saving" ? "Saving…" : "Saved"}
          </output>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "configuration",
    component: ThreadLimitSettings,
  });
});
