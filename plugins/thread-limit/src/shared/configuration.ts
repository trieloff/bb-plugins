import { z } from "zod";
import { MAX_LIMIT_VALUE } from "./limits.ts";
import type { LoadLimits } from "./load.ts";

// Copied from bb's concurrency-limit plugin (plugins/concurrency-limit/server.ts
// at desktop-v0.46.1), so a configuration means the same thing in both.

/** Settings pages re-read the configuration when this channel fires. */
export const CONFIGURATION_CHANGED_CHANNEL = "configuration-changed";

const limitSchema = z.number().int().min(0).max(MAX_LIMIT_VALUE);
const hostOverrideSchema = z
  .object({
    hostId: z.string().min(1).max(256),
    limit: limitSchema,
  })
  .strict();
const percentSchema = z.number().int().min(1).max(100);
// Added for the copy: load limits, applied to each host on its own load.
export const loadLimitsSchema = z
  .object({
    cpuBusyPercent: percentSchema.nullable(),
    memoryFreePercent: percentSchema.nullable(),
  })
  .strict();
const configurationShape = {
  globalLimit: limitSchema.nullable(),
  hostOverrides: z.array(hostOverrideSchema).max(256),
};

/**
 * A stored or submitted configuration. `loadLimits` is optional so the slot
 * editors, copied from bb's settings page, can save without knowing about it:
 * an absent `loadLimits` keeps the current ones.
 */
export const configurationSchema = z
  .object({ ...configurationShape, loadLimits: loadLimitsSchema.optional() })
  .strict()
  .superRefine((configuration, context) => {
    const seen = new Set<string>();
    for (const override of configuration.hostOverrides) {
      if (seen.has(override.hostId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate host override for ${override.hostId}`,
          path: ["hostOverrides"],
        });
      }
      seen.add(override.hostId);
    }
  });

export const capacityRecordsSchema = z
  .array(
    z
      .object({
        hostId: z.string().min(1).max(256),
        availableParallelism: z.number().int().positive(),
      })
      .strict(),
  )
  .max(256);

const loadSampleSchema = z
  .object({
    cpuBusyPercent: z.number(),
    memoryFreePercent: z.number().nullable(),
    loadAverage: z.number(),
    sampledAt: z.number(),
  })
  .strict();

export const hostViewSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    status: z.enum(["connected", "disconnected"]),
    availableParallelism: z.number().int().positive().nullable(),
    automaticLimit: limitSchema,
    effectiveLimit: limitSchema,
    override: limitSchema.nullable(),
    // Added for the copy: the latest fresh load sample, and why the host is
    // holding new turns for load, if it is.
    load: loadSampleSchema.nullable(),
    overloadedBy: z.string().nullable(),
  })
  .strict();

export const configurationViewSchema = z
  .object({
    ...configurationShape,
    loadLimits: loadLimitsSchema,
    hosts: z.array(hostViewSchema),
  })
  .strict();

/** What a save submits; an absent `loadLimits` keeps the current ones. */
export type ConfigurationInput = z.infer<typeof configurationSchema>;
/** The configuration in force, load limits always resolved. */
export type Configuration = Omit<ConfigurationInput, "loadLimits"> & { loadLimits: LoadLimits };
export type CapacityRecord = z.infer<typeof capacityRecordsSchema>[number];
export type HostView = z.infer<typeof hostViewSchema>;
export type ConfigurationView = z.infer<typeof configurationViewSchema>;
