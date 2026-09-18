import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const gitButlerHostContract = defineRpcContract({
  branchSummary: {
    input: z.object({ cwd: z.string().trim().min(1) }),
    output: z.object({
      label: z.string().nullable(),
      branchNames: z.array(z.string().trim().min(1)).max(16).default([]),
    }),
  },
  githubRepoContext: {
    input: z.object({ cwd: z.string().trim().min(1) }).strict(),
    output: z
      .object({
        owner: z.string().nullable(),
        repo: z.string().nullable(),
      })
      .strict(),
  },
});
