// bb 0.46 refuses to let a plugin register a provider whose id is already
// taken, and an "amp" custom ACP agent left by the provisioning era takes
// "acp-amp". It can sit in config.json's customAcpAgents (bb before 0.46) or
// in the provider-acp plugin's `customAgents` setting (bb 0.46 migrated it
// there). These tests load the real server entry against a fake bb that
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

const AUGGIE = { id: "auggie", displayName: "Auggie", command: "/bin/auggie" };

function ids(agents: unknown): string[] {
  return Array.isArray(agents) ? agents.map((agent: { id: string }) => agent.id) : [];
}

function configAgentIds(configPath: string): string[] {
  try {
    return ids(JSON.parse(readFileSync(configPath, "utf8")).customAcpAgents);
  } catch {
    return [];
  }
}

function settingAgentIds(customAgents: string): string[] {
  return customAgents === "" ? [] : ids(JSON.parse(customAgents));
}

interface LegacyFixture {
  /** config.json's customAcpAgents, as bb before 0.46 kept them. */
  config?: Record<string, unknown>[];
  /** provider-acp's `customAgents`, as bb 0.46 keeps them. */
  setting?: Record<string, unknown>[];
  /** How long bb keeps listing the setting's provider after the write. */
  settingDropMs?: number;
}

async function loadWithLegacyEntry(fixture: LegacyFixture) {
  const dataDir = mkdtempSync(join(tmpdir(), "amp-legacy-entry-"));
  scratch.push(dataDir);
  const configPath = join(dataDir, "config.json");
  if (fixture.config)
    writeFileSync(configPath, JSON.stringify({ customAcpAgents: fixture.config }));
  let customAgents = fixture.setting ? JSON.stringify(fixture.setting, null, 2) : "";

  // bb serves each source's "amp" as provider "acp-amp": config.json's until
  // the config is reloaded, the setting's until provider-acp re-registers.
  let configLive = configAgentIds(configPath).includes("amp");
  let settingLive = settingAgentIds(customAgents).includes("amp");
  let reloads = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "amp",
    sdk: {
      providers: {
        list: async () => (configLive || settingLive ? [{ id: "acp-amp" }] : []),
      },
      plugins: {
        getSettings: async ({ pluginId }: { pluginId: string }) => {
          assert.equal(pluginId, "provider-acp");
          return { values: { customAgents } };
        },
        updateSettings: async ({ values }: { values: { customAgents: string } }) => {
          customAgents = values.customAgents;
          const live = settingAgentIds(customAgents).includes("amp");
          setTimeout(() => (settingLive = live), fixture.settingDropMs ?? 0);
        },
      },
      system: {
        config: async () => ({ dataDir }),
        reloadConfig: async () => {
          reloads += 1;
          configLive = configAgentIds(configPath).includes("amp");
        },
      },
    } as never,
  });
  const register = bb.providers.register.bind(bb.providers);
  bb.providers.register = ((declaration) => {
    if (configLive || settingLive) {
      throw new Error(
        'Provider "acp-amp" is already registered; a plugin cannot shadow an existing provider.',
      );
    }
    return register(declaration);
  }) as typeof bb.providers.register;

  await createAmpPlugin(() => undefined)(bb);
  await harness.behavior.runService("register").done;
  return {
    configAgents: () => configAgentIds(configPath),
    settingAgents: () => settingAgentIds(customAgents),
    harness,
    reloads: () => reloads,
  };
}

function registeredIds(harness: FakePluginHarness): string[] {
  return harness.registrations.providerRegistrations.map((provider) => provider.id);
}

test("a plugin-managed config.json entry makes room, then the provider registers", async () => {
  const run = await loadWithLegacyEntry({ config: [legacyEntry()] });
  assert.deepEqual(run.configAgents(), []);
  assert.equal(run.reloads(), 1);
  assert.deepEqual(registeredIds(run.harness), ["acp-amp"]);
  assert.deepEqual(run.harness.needsConfigurationMessages, []);
});

test("a plugin-managed provider-acp agent makes room once bb drops it", async () => {
  const run = await loadWithLegacyEntry({
    setting: [legacyEntry(), AUGGIE],
    // provider-acp re-registers its agents after the write, not during it.
    settingDropMs: 300,
  });
  assert.deepEqual(run.settingAgents(), ["auggie"]);
  assert.deepEqual(registeredIds(run.harness), ["acp-amp"]);
  assert.deepEqual(run.harness.needsConfigurationMessages, []);
});

test("a customized entry stays, and the refusal is reported", async () => {
  const run = await loadWithLegacyEntry({
    config: [legacyEntry({ displayName: "My Amp" })],
    setting: [legacyEntry({ cwd: "/work" })],
  });
  assert.deepEqual(run.configAgents(), ["amp"]);
  assert.deepEqual(run.settingAgents(), ["amp"]);
  assert.equal(run.reloads(), 0);
  assert.deepEqual(registeredIds(run.harness), []);
  assert.equal(run.harness.needsConfigurationMessages.length, 1);
  assert.match(run.harness.needsConfigurationMessages[0]!, /already registered/);
});
