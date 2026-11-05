import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectionIndexes,
  ensureCollectionIndexes,
} from "../src/config/indexes.js";

function createMockDatabase({ failFor = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    collection(name) {
      return {
        async createIndex(key, options) {
          calls.push({ collection: name, key, options });
          if (failFor.has(options.name)) {
            throw new Error("IndexKeySpecsConflict: an index with this name already exists");
          }
          return options.name;
        },
      };
    },
  };
}

test("booking index definitions cover user history and studio overlap lookups", () => {
  assert.deepEqual(collectionIndexes.bookings, [
    {
      name: "bookings_user_createdAt",
      key: { userId: 1, createdAt: -1 },
    },
    {
      name: "bookings_studio_status_window",
      key: { studioId: 1, status: 1, startAt: 1, endAt: 1 },
    },
  ]);
});

test("booking index names are unique so they cannot conflict with each other", () => {
  const names = collectionIndexes.bookings.map((index) => index.name);
  assert.equal(new Set(names).size, names.length);
});

test("ensureCollectionIndexes creates every declared index", async () => {
  const db = createMockDatabase();
  const result = await ensureCollectionIndexes(db);

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.created, [
    "bookings.bookings_user_createdAt",
    "bookings.bookings_studio_status_window",
  ]);
  assert.equal(db.calls.length, 2);
  assert.deepEqual(db.calls[0], {
    collection: "bookings",
    key: { userId: 1, createdAt: -1 },
    options: { name: "bookings_user_createdAt" },
  });
});

test("ensureCollectionIndexes is idempotent across repeated runs", async () => {
  const db = createMockDatabase();

  const first = await ensureCollectionIndexes(db);
  const second = await ensureCollectionIndexes(db);

  assert.deepEqual(first.failed, []);
  // MongoDB treats an identical createIndex as a no-op, so repeated startup
  // runs issue the same calls without creating duplicates or errors.
  assert.deepEqual(second.failed, []);
  assert.deepEqual(second.created, first.created);
});

test("ensureCollectionIndexes reports conflicts without throwing", async () => {
  const db = createMockDatabase({
    failFor: new Set(["bookings_studio_status_window"]),
  });

  const result = await ensureCollectionIndexes(db);

  assert.deepEqual(result.created, ["bookings.bookings_user_createdAt"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].collection, "bookings");
  assert.equal(result.failed[0].name, "bookings_studio_status_window");
  assert.match(result.failed[0].reason, /IndexKeySpecsConflict/);
});

test("ensureCollectionIndexes is a no-op when the database is unavailable", async () => {
  assert.deepEqual(await ensureCollectionIndexes(null), {
    created: [],
    failed: [],
  });
  assert.deepEqual(await ensureCollectionIndexes(undefined), {
    created: [],
    failed: [],
  });
});
