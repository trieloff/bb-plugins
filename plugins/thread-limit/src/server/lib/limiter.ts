import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  capacityRecordsSchema,
  configurationSchema,
  CONFIGURATION_CHANGED_CHANNEL,
  type CapacityRecord,
  type Configuration,
  type ConfigurationInput,
  type ConfigurationView,
} from "../../shared/configuration.ts";
import { automaticHostLimit, resolveHostLimit } from "../../shared/limits.ts";
import {
  DEFAULT_LOAD_LIMITS,
  LOAD_STALE_MS,
  overloadReason,
  type LoadLimits,
  type LoadSample,
} from "../../shared/load.ts";

// The state half of bb's concurrency-limit plugin (plugins/concurrency-limit/
// server.ts at desktop-v0.46.1): the stored configuration, the detected
// processor counts, and the view both the CLI and the settings page read.
// Added for the copy: load limits and each host's latest load sample.

const CONFIGURATION_KEY = "configuration";
const CAPACITIES_KEY = "host-capacities";

const DEFAULT_CONFIGURATION: Configuration = {
  globalLimit: null,
  hostOverrides: [],
  loadLimits: DEFAULT_LOAD_LIMITS,
};

export function normalizeConfiguration(
  configuration: ConfigurationInput,
  currentLoadLimits: LoadLimits = DEFAULT_LOAD_LIMITS,
): Configuration {
  return {
    globalLimit: configuration.globalLimit,
    hostOverrides: [...configuration.hostOverrides].sort((left, right) =>
      left.hostId.localeCompare(right.hostId),
    ),
    loadLimits: configuration.loadLimits ?? currentLoadLimits,
  };
}

/** A host's latest load, and why it holds new turns for it, if it does. */
export interface HostLoad {
  readonly sample: LoadSample;
  readonly overloadedBy: string | null;
}

export interface Limiter {
  /** The configuration in force. */
  configuration(): Configuration;
  /** Detected processors per host id, shared with the capacity detector. */
  readonly capacities: Map<string, number>;
  /** Reads the stored configuration and capacities. Runs once, in setup. */
  load(): Promise<void>;
  view(signal?: AbortSignal): Promise<ConfigurationView>;
  /**
   * Stores a configuration, tells settings pages, and re-runs held turns. A
   * configuration without `loadLimits` keeps the current ones.
   */
  save(next: ConfigurationInput): Promise<void>;
  persistCapacities(): Promise<void>;
  /**
   * Records a host's sample and judges it against the load limits. `released`
   * means the host stopped holding turns, so the caller rechecks; `changed`
   * means it started or stopped, so settings pages refresh.
   */
  recordLoad(hostId: string, sample: LoadSample): { released: boolean; changed: boolean };
  forgetLoad(hostId: string): void;
  /** The host's load if its sample is fresh; stale or missing is unknown. */
  loadFor(hostId: string, now?: number): HostLoad | null;
}

export function createLimiter(bb: BbPluginApi): Limiter {
  let configuration = DEFAULT_CONFIGURATION;
  const capacities = new Map<string, number>();
  const loads = new Map<string, HostLoad>();

  function loadFor(hostId: string, now = Date.now()): HostLoad | null {
    const load = loads.get(hostId);
    return load !== undefined && now - load.sample.sampledAt <= LOAD_STALE_MS ? load : null;
  }

  return {
    configuration: () => configuration,
    capacities,
    async load() {
      const storedConfiguration = configurationSchema.safeParse(
        await bb.storage.kv.get<unknown>(CONFIGURATION_KEY),
      );
      configuration = storedConfiguration.success
        ? normalizeConfiguration(storedConfiguration.data)
        : DEFAULT_CONFIGURATION;
      const storedCapacities = capacityRecordsSchema.safeParse(
        await bb.storage.kv.get<unknown>(CAPACITIES_KEY),
      );
      capacities.clear();
      for (const record of storedCapacities.success ? storedCapacities.data : []) {
        capacities.set(record.hostId, record.availableParallelism);
      }
    },
    async view(signal) {
      const availableHosts = await bb.sdk.hosts.list(signal === undefined ? undefined : { signal });
      return {
        ...configuration,
        hosts: availableHosts.map(({ id, name, status }) => {
          const availableParallelism = capacities.get(id) ?? null;
          const resolved = resolveHostLimit(configuration, id, availableParallelism);
          const load = loadFor(id);
          return {
            id,
            name,
            status,
            availableParallelism,
            automaticLimit: automaticHostLimit(availableParallelism),
            effectiveLimit: resolved.limit,
            override: resolved.mode === "override" ? resolved.limit : null,
            load: load?.sample ?? null,
            overloadedBy: load?.overloadedBy ?? null,
          };
        }),
      };
    },
    async save(next) {
      const normalized = normalizeConfiguration(next, configuration.loadLimits);
      await bb.storage.kv.set(CONFIGURATION_KEY, normalized);
      configuration = normalized;
      // New load limits judge every host afresh, without the release gap,
      // so loosening a limit lets held turns go on this very recheck.
      for (const [hostId, load] of loads) {
        loads.set(hostId, {
          sample: load.sample,
          overloadedBy: overloadReason(load.sample, configuration.loadLimits, false),
        });
      }
      bb.realtime.publish(CONFIGURATION_CHANGED_CHANNEL, {});
      await bb.experimental_hooks.recheck("message.dispatch");
    },
    async persistCapacities() {
      const records: CapacityRecord[] = [...capacities]
        .map(([hostId, availableParallelism]) => ({ hostId, availableParallelism }))
        .sort((left, right) => left.hostId.localeCompare(right.hostId));
      await bb.storage.kv.set(CAPACITIES_KEY, records);
    },
    recordLoad(hostId, sample) {
      const previous = loadFor(hostId, sample.sampledAt);
      const wasOverloaded = previous !== null && previous.overloadedBy !== null;
      const overloadedBy = overloadReason(sample, configuration.loadLimits, wasOverloaded);
      loads.set(hostId, { sample, overloadedBy });
      return {
        released: wasOverloaded && overloadedBy === null,
        changed: wasOverloaded !== (overloadedBy !== null),
      };
    },
    forgetLoad(hostId) {
      loads.delete(hostId);
    },
    loadFor,
  };
}

export function setHostOverride(
  configuration: Configuration,
  hostId: string,
  limit: number | null,
): Configuration {
  const hostOverrides = configuration.hostOverrides.filter(
    (override) => override.hostId !== hostId,
  );
  if (limit !== null) hostOverrides.push({ hostId, limit });
  return normalizeConfiguration({ ...configuration, hostOverrides });
}
