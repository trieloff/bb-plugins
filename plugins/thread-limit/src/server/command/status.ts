import { defineCommand, type CommandContext } from "@bb-kit/core/command";
import type { Context } from "@bb-kit/core/plugin";
import { formatLoadLimits } from "../../shared/load.ts";
import { PINNED_EXEMPTION_LINE, formatHostLine } from "../lib/cli-format.ts";
import type { Limiter } from "../lib/limiter.ts";

export const status = defineCommand({
  summary: "Show effective thread limits",
  options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
  async execute(ctx: CommandContext<Context<{ limiter: Limiter }>>, { options }) {
    const view = await ctx.limiter.view();
    return {
      exitCode: 0,
      stdout: options.json
        ? JSON.stringify(view)
        : [
            `Overall: ${view.globalLimit === null ? "unlimited" : view.globalLimit}`,
            "Automatic host limit: one thread per available processor",
            formatLoadLimits(view.loadLimits),
            PINNED_EXEMPTION_LINE,
            ...view.hosts.map(formatHostLine),
          ].join("\n"),
    };
  },
});
