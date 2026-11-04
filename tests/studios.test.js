import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ObjectId } from "mongodb";
import { createApp } from "../src/app.js";
import { registerStudioRoutes } from "../index.js";

const servers = [];
const baseRecord = () => ({
  _id: new ObjectId("65c7a6b0c9d2fddc4493e001"),
  title: "Daylight Photo Studio",
  slug: "daylight-photo-studio",
  category: "Photo Studios",
  categorySlug: "photo-studios",
  hourlyRate: 95,
  securityDeposit: 150,
  capacity: 8,
  location: "Brooklyn, New York",
  image: "/images/daylight.jpg",
  amenities: ["Natural light", "Backdrop"],
  overview: "A sample listing for test purposes.",
  host: {
    name: "Studio Host",
    bio: "Public host biography",
    email: "private@example.test",
  },
  passwordHash: "must-not-be-public",
});

function createMockDatabase({ records = [], total = records.length, detail } = {}) {
  const calls = {};
  const collection = {
    countDocuments: async (filter) => {
      calls.countFilter = filter;
      return total;
    },
    find(filter, options) {
      calls.find = { filter, options };
      return {
        sort(value) {
          calls.sort = value;
          return this;
        },
        skip(value) {
          calls.skip = value;
          return this;
        },
        limit(value) {
          calls.limit = value;
          return this;
        },
        async toArray() {
          return records;
        },
      };
    },
    async findOne(filter, options) {
      calls.findOne = { filter, options };
      return detail ?? records[0] ?? null;
    },
  };

  return {
    calls,
    collectionName: undefined,
    collection(name) {
      this.collectionName = name;
      return collection;
    },
  };
}

async function withServer(database, run) {
  const app = createApp({
    registerRoutes: (expressApp) =>
      registerStudioRoutes(expressApp, { getDatabase: () => database }),
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  return run(`http://127.0.0.1:${server.address().port}`);
}

after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

test("GET /api/studios returns an empty list and zero total pages", async () => {
  const database = createMockDatabase();
  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      message: "Studios retrieved successfully",
      data: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
    });
    assert.equal(database.collectionName, "studios");
  });
});

test("GET /api/studios serializes public studio data without private fields", async () => {
  const record = baseRecord();
  const database = createMockDatabase({ records: [record] });
  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data[0].id, String(record._id));
    assert.equal(body.data[0].title, record.title);
    assert.equal(body.data[0].host.name, "Studio Host");
    assert.equal("email" in body.data[0].host, false);
    assert.equal("passwordHash" in body.data[0], false);
    assert.equal("_id" in body.data[0], false);
  });
});

test("category and price query parameters build bounded MongoDB filters", async () => {
  const database = createMockDatabase();
  await withServer(database, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/studios?category=photo-studios&minPrice=50&maxPrice=120`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(database.calls.find.filter, {
      categorySlug: "photo-studios",
      hourlyRate: { $gte: 50, $lte: 120 },
    });
    assert.deepEqual(database.calls.countFilter, database.calls.find.filter);
  });
});

test("search is escaped and only targets known public fields", async () => {
  const database = createMockDatabase();
  await withServer(database, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/studios?search=${encodeURIComponent("art (room).*")}`,
    );
    assert.equal(response.status, 200);
    const searchFields = database.calls.find.filter.$or;
    assert.deepEqual(
      searchFields.map((condition) => Object.keys(condition)[0]),
      ["title", "name", "location", "category", "overview", "amenities"],
    );
    const expression = searchFields[0].title;
    assert.equal(expression.test("art (room).*"), true);
    assert.equal(expression.test("art roomZZ"), false);
  });
});

test("sort options use fixed MongoDB sort expressions", async (t) => {
  for (const [sort, expected] of [
    ["newest", { createdAt: -1, _id: -1 }],
    ["price-low", { hourlyRate: 1, _id: 1 }],
    ["price-high", { hourlyRate: -1, _id: 1 }],
  ]) {
    await t.test(sort, async () => {
      const database = createMockDatabase();
      await withServer(database, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/studios?sort=${sort}`);
        assert.equal(response.status, 200);
        assert.deepEqual(database.calls.sort, expected);
      });
    });
  }
});

test("pagination applies MongoDB skip and limit and returns total pages", async () => {
  const database = createMockDatabase({ total: 45 });
  await withServer(database, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/studios?page=3&limit=10`,
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(database.calls.skip, 20);
    assert.equal(database.calls.limit, 10);
    assert.deepEqual(body.pagination, {
      page: 3,
      limit: 10,
      total: 45,
      totalPages: 5,
    });
  });
});

test("invalid query parameters return safe HTTP 400 errors", async (t) => {
  const invalidQueries = [
    "category=unknown",
    "minPrice=-1",
    "minPrice=120&maxPrice=50",
    "page=0",
    "page=9007199254740991&limit=100",
    "limit=101",
    "sort=hourlyRate",
    "search=a&search=b",
  ];

  for (const query of invalidQueries) {
    await t.test(query, async () => {
      await withServer(createMockDatabase(), async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/studios?${query}`);
        const body = await response.json();
        assert.equal(response.status, 400);
        assert.equal(body.success, false);
        assert.equal(body.code, "INVALID_QUERY");
        assert.equal(body.details, null);
      });
    });
  }
});

test("GET /api/studios/:id looks up valid MongoDB ObjectIds", async () => {
  const record = baseRecord();
  const database = createMockDatabase({ detail: record });
  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios/${record._id}`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(database.calls.findOne.filter, { _id: record._id });
    assert.equal(body.data.id, String(record._id));
  });
});

test("GET /api/studios/:id looks up non-ObjectId slugs", async () => {
  const database = createMockDatabase({ detail: baseRecord() });
  await withServer(database, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/studios/daylight-photo-studio`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(database.calls.findOne.filter, {
      slug: "daylight-photo-studio",
    });
  });
});

test("unknown studio returns the standard not-found response", async () => {
  const database = createMockDatabase({ detail: null });
  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios/missing-studio`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      success: false,
      message: "Studio not found",
      code: "STUDIO_NOT_FOUND",
      details: null,
    });
  });
});

test("studio endpoints return 503 when no database is available", async () => {
  await withServer(null, async (baseUrl) => {
    const listResponse = await fetch(`${baseUrl}/api/studios`);
    const detailResponse = await fetch(`${baseUrl}/api/studios/any-studio`);
    assert.equal(listResponse.status, 503);
    assert.equal(detailResponse.status, 503);
    assert.deepEqual(await listResponse.json(), {
      success: false,
      message: "Database is not available",
      code: "DATABASE_NOT_READY",
      details: null,
    });
  });
});
