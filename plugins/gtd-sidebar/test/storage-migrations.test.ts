import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { migrationsForDatabase } from "../server.ts";

const FORK_INDEX_2_HASH = "a6a0d865796db1744b25841bbedacf5d66fef12f1edce393e3f19b38320e558b";
const UPSTREAM_INDEX_2_HASH = "e022af723c4c0b9b2661cde98a11746852e161388588fdd97979b1f98baf23f4";
const LIVE_FORK_PREFIX = [
  "acbf655d5b136efc5cf04ac5c1c46fcb89f4c5e7b76bf55c45d7aef226ce8059",
  "98189c1105973e4f7ad5067dacbe42eb934c24a81250fbda17b80da3de5bfc04",
  FORK_INDEX_2_HASH,
  "0d720ff41cd73a6387a947ac1e0ef48804894a5dbbf928a75ef18b9145cb8476",
  "b79ce53d781c6686c6db022210255b6da55e7997404719b2309197b85f78300d",
  "002d33bee7b0badf1c100ff979ced5e88215698c2c590975df06e4223018e8f3",
  "fa2d16485fb21df5079938fe3903ac4541f5a48836f99aeeb8dcbe19ac80b343",
  "27f1167a17bc854d86dab4c4ccb36c7690dc272e1d316ea810b50de7d9d299da",
];

function hash(statement: string): string {
  return createHash("sha256").update(statement).digest("hex");
}

function databaseWithMigration(
  migration: { statement_hash: string | null } | undefined,
  forkTableExists = false,
): Parameters<typeof migrationsForDatabase>[0] {
  return {
    prepare(sql) {
      return {
        get() {
          if (sql.includes("FROM _bb_migrations")) return migration;
          return forkTableExists ? { exists: 1 } : undefined;
        },
      };
    },
  };
}

describe("storage migration history", () => {
  it("keeps the live fork's recorded prefix and appends archive settlement", () => {
    const migrations = migrationsForDatabase(
      databaseWithMigration({ statement_hash: FORK_INDEX_2_HASH }),
    );

    assert.deepEqual(migrations.slice(0, LIVE_FORK_PREFIX.length).map(hash), LIVE_FORK_PREFIX);
    assert.equal(hash(migrations.at(-1)!), UPSTREAM_INDEX_2_HASH);
  });

  it("keeps upstream's index 2 and appends the fork migrations", () => {
    const migrations = migrationsForDatabase(
      databaseWithMigration({ statement_hash: UPSTREAM_INDEX_2_HASH }),
    );

    assert.equal(hash(migrations[2]!), UPSTREAM_INDEX_2_HASH);
    assert.equal(hash(migrations[3]!), FORK_INDEX_2_HASH);
  });

  it("distinguishes pre-hash histories by the fork's index 2 table", () => {
    const upstream = migrationsForDatabase(databaseWithMigration({ statement_hash: null }));
    const fork = migrationsForDatabase(databaseWithMigration({ statement_hash: null }, true));

    assert.equal(hash(upstream[2]!), UPSTREAM_INDEX_2_HASH);
    assert.equal(hash(fork[2]!), FORK_INDEX_2_HASH);
  });

  it("starts fresh databases on the fork's established order", () => {
    const migrations = migrationsForDatabase(databaseWithMigration(undefined));

    assert.equal(hash(migrations[2]!), FORK_INDEX_2_HASH);
  });
});
