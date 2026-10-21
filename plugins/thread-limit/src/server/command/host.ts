import { defineCommand, type CommandContext } from "@bb-kit/core/command";
import type { Context } from "@bb-kit/core/plugin";
import { MAX_LIMIT_VALUE } from "../../shared/limits.ts";
import { formatHostLine, parseLimitArgument, unknownHost } from "../lib/cli-format.ts";
import { setHostOverride, type Limiter } from "../lib/limiter.ts";

export const host = defineCommand({
  summary: "Show or set one host limit",
  positionals: [
    {
      name: "host-id",
      description: "Enrolled host id, as `bb machine list` prints it",
      required: true,
    },
    {
      name: "limit",
      description: `auto, or a whole number from 0 to ${MAX_LIMIT_VALUE} (0 holds every new turn on that host); omit it to print the host's limit`,
    },
  ],
  options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
  async execute(ctx: CommandContext<Context<{ limiter: Limiter }>>, { positionals, options }) {
    const hostId = positionals["host-id"];
    const view = await ctx.limiter.view();
    if (!view.hosts.some((candidate) => candidate.id === hostId)) throw unknownHost(hostId);
    const requested = positionals.limit;
    if (requested !== undefined) {
      await ctx.limiter.save(
        setHostOverride(ctx.limiter.configuration(), hostId, parseLimitArgument(requested, "auto")),
      );
    }
    const updated = (await ctx.limiter.view()).hosts.find((candidate) => candidate.id === hostId);
    if (updated === undefined) throw unknownHost(hostId);
    return {
      exitCode: 0,
      stdout: options.json ? JSON.stringify(updated) : formatHostLine(updated),
    };
  },
});
