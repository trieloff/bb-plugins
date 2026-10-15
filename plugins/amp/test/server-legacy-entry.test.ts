// bb 0.46 refuses to let a plugin register a provider whose id is already
// taken, and a customAcpAgents "amp" entry left by the provisioning era takes
// "acp-amp". These tests load the real server entry against a fake bb that
// refuses the same way, and pin that a plugin-managed entry makes room for the
// registration while a customized one is left alone.
import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { AMP_NATIVE_SKILL_ROOTS } from "../lib/provision.ts";
import { createAmpPlugin } from "../server.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The entry the provisioning era wrote, with any user customization. */
function legacyEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "amp",
    displayName: "Amp",
    command: "/usr/local/bin/node",
    args: ["/old/plugin-cache/abc123/dist/bridge.js"],
    env: { AMP_CLI_PATH: "/usr/local/bin/amp" },
    logo: "logos/amp.svg",
    nativeSkillRoots: AMP_NATIVE_SKILL_ROOTS,
    ...overrides,
  };
}

function agentIds(configPath: string): string[] {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    customAcpAgents?: { id: string }[];
  };
  return (config.customAcpAgents ?? []).map((agent) => agent.id);
}

async function loadWithLegacyEntry(entry: Record<string, unknown>) {
  const dataDir = mkdtempSync(join(tmpdir(), "amp-legacy-entry-"));
  scratch.push(dataDir);
  const configPath = join(dataDir, "config.json");
  writeFileSync(configPath, JSON.stringify({ customAcpAgents: [entry] }));

  // bb serves the entry as provider "acp-amp" until its config is reloaded.
  let configured = agentIds(configPath);
  let reloads = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "amp",
    sdk: {
      providers: { list: async () => [] },
      system: {
        config: async () => ({ dataDir }),
        reloadConfig: async () => {
          reloads += 1;
          configured = agentIds(configPath);
        },
      },
    } as never,
  });
  const register = bb.providers.register.bind(bb.providers);
  bb.providers.register = ((declaration) => {
    if (configured.includes("amp")) {
      throw new Error(
        'Provider "acp-amp" is already registered; a plugin cannot shadow an existing provider.',
      );
    }
    return register(declaration);
  }) as typeof bb.providers.register;

  await createAmpPlugin(() => undefined)(bb);
  await harness.behavior.runService("register").done;
  return { configPath, harness, reloads: () => reloads };
}

function registeredIds(harness: FakePluginHarness): string[] {
  return harness.registrations.providerRegistrations.map((provider) => provider.id);
}

test("a plugin-managed legacy entry makes room, then the provider registers", async () => {
  const { configPath, harness, reloads } = await loadWithLegacyEntry(legacyEntry());
  assert.deepEqual(agentIds(configPath), []);
  assert.equal(reloads(), 1);
  assert.deepEqual(registeredIds(harness), ["acp-amp"]);
  assert.deepEqual(harness.needsConfigurationMessages, []);
});

test("a customized legacy entry stays, and the refusal is reported", async () => {
  const { configPath, harness, reloads } = await loadWithLegacyEntry(
    legacyEntry({ displayName: "My Amp" }),
  );
  assert.deepEqual(agentIds(configPath), ["amp"]);
  assert.equal(reloads(), 0);
  assert.deepEqual(registeredIds(harness), []);
  assert.equal(harness.needsConfigurationMessages.length, 1);
  assert.match(harness.needsConfigurationMessages[0]!, /already registered/);
});
