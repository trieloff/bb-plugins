import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const threadLimitHostContract = defineRpcContract({
  getCapacity: {
    input: z.null(),
    output: z
      .object({
        availableParallelism: z.number().int().positive(),
      })
      .strict(),
  },
  // Added for the copy: the host's load, for load limits.
  getLoad: {
    input: z.null(),
    output: z
      .object({
        cpuBusyPercent: z.number().min(0).max(100),
        memoryFreePercent: z.number().min(0).max(100).nullable(),
        loadAverage: z.number().min(0),
      })
      .strict(),
  },
});
