import { defineCommand, PluginCliError, type CommandContext } from "@bb-kit/core/command";
import type { Context } from "@bb-kit/core/plugin";
import { formatLoadLimits, parsePercent } from "../../shared/load.ts";
import { formatHostLine } from "../lib/cli-format.ts";
import type { Limiter } from "../lib/limiter.ts";

const SIGNALS = { cpu: "cpuBusyPercent", memory: "memoryFreePercent" } as const;

export const load = defineCommand({
  summary: "Show or set the load at which a host holds new turns",
  positionals: [
    {
      name: "signal",
      description:
        "cpu (hold while CPU is at least this busy) or memory (hold while free memory is at most this); omit both to print the limits and each host's load",
    },
    { name: "percent", description: "a whole percent from 1 to 100, or off" },
  ],
  options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
  async execute(ctx: CommandContext<Context<{ limiter: Limiter }>>, { positionals, options }) {
    const signal = positionals.signal;
    if (signal !== undefined) {
      if (signal !== "cpu" && signal !== "memory") {
        throw new PluginCliError(`Unknown load signal: ${signal}`, {
          code: "invalid_signal",
          hint: "Use cpu or memory.",
        });
      }
      const raw = positionals.percent;
      if (raw === undefined) {
        throw new PluginCliError(`Give a percent for ${signal}, or off`, {
          code: "missing_percent",
        });
      }
      const percent = parsePercent(raw);
      if (percent === undefined) {
        throw new PluginCliError("Load limits must be off or a whole percent from 1 to 100", {
          code: "invalid_percent",
        });
      }
      const current = ctx.limiter.configuration();
      await ctx.limiter.save({
        ...current,
        loadLimits: { ...current.loadLimits, [SIGNALS[signal]]: percent },
      });
    }
    const view = await ctx.limiter.view();
    return {
      exitCode: 0,
      stdout: options.json
        ? JSON.stringify({
            loadLimits: view.loadLimits,
            hosts: view.hosts.map(({ id, name, load, overloadedBy }) => ({
              id,
              name,
              load,
              overloadedBy,
            })),
          })
        : [formatLoadLimits(view.loadLimits), ...view.hosts.map(formatHostLine)].join("\n"),
    };
  },
});
