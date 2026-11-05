import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ObjectId } from "mongodb";
import { createApp } from "../src/app.js";
import { registerStudioRoutes } from "../index.js";

const servers = [];
const authenticatedUser = {
  id: "better-auth-user-123",
  email: "  Creator@Example.Test ",
  name: "Authenticated Creator",
  image: "https://images.example.test/creator.jpg",
};
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

const validStudioPayload = (overrides = {}) => ({
  title: "Daylight Photo Studio",
  categorySlug: "photo-studios",
  hourlyRate: 95,
  securityDeposit: 150,
  capacity: 8,
  location: "Brooklyn, New York",
  image: "https://images.example.test/daylight-studio.jpg",
  imageAlt: "A bright photography studio",
  amenities: [
    "Natural light",
    "Backdrop",
    " changing area ",
    " natural LIGHT ",
  ],
  overview:
    "A bright, flexible studio with room for portrait sessions and small productions.",
  ...overrides,
});

function createTestAuthenticate({ user = authenticatedUser } = {}) {
  return (request, _response, next) => {
    request.user = user;
    next();
  };
}

function createMockDatabase({
  records = [],
  bookingRecords = [],
  total = records.length,
  detail,
  insertError,
  deleteResult,
} = {}) {
  const calls = {
    insertedDocuments: [],
    deleteOne: [],
    findOneCalls: [],
  };
  let selectedCollectionName = "studios";
  const collection = {
    countDocuments: async (filter) => {
      calls.countFilter = filter;
      return total;
    },
    find(filter = {}, options) {
      calls.find = { filter, options };
      let result = records.filter((record) => {
        if (!filter || typeof filter !== "object") return true;
        for (const [key, value] of Object.entries(filter)) {
          if (key === "$or") continue;
          if (record[key] !== value) return false;
        }
        return true;
      });
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
          return result;
        },
      };
    },
    async findOne(filter, options) {
      calls.findOne = { filter, options };
      calls.findOneCalls.push({
        collection: selectedCollectionName,
        filter,
      });
      if (selectedCollectionName === "bookings") {
        return bookingRecords.find((record) =>
          Object.entries(filter || {}).every(([key, value]) => {
            if (record[key] instanceof ObjectId && value instanceof ObjectId) {
              return record[key].equals(value);
            }
            return record[key] === value;
          }),
        ) ?? null;
      }
      if (detail !== undefined) {
        if (filter?._id && detail._id && !detail._id.equals(filter._id) && typeof filter._id === "object") {
          // fall through
        } else if (detail !== null) {
          // if it's a specific detail for findOne calls, return it when appropriate? existing behavior
        }
        // For compatibility with existing tests, if detail is set and we need to be flexible
      }
      if (filter?._id) {
        const found = records.find((record) => record._id.equals(filter._id));
        if (found) return found;
        if (detail !== undefined) return detail;
        return null;
      }
      if (filter?.slug) {
        const found = records.find((record) => record.slug === filter.slug);
        if (found) return found;
        if (detail !== undefined && detail?.slug === filter.slug) return detail;
        return null;
      }
      if (detail !== undefined) return detail;
      return records[0] ?? null;
    },
    async insertOne(document) {
      calls.insertedDocuments.push(document);
      if (insertError) throw insertError;
      records.push(document);
      return { acknowledged: true, insertedId: document._id };
    },
    async updateOne(filter, update) {
      calls.updateOne = { filter, update };
      let record = null;
      if (filter?._id) {
        record = records.find((r) => r._id.equals(filter._id));
      } else if (filter?.slug) {
        record = records.find((r) => r.slug === filter.slug);
      } else if (records[0]) {
        record = records[0];
      }
      if (record && update?.$set) {
        Object.assign(record, update.$set);
      }
      return { acknowledged: true, modifiedCount: record ? 1 : 0 };
    },
    async deleteOne(filter) {
      calls.deleteOne.push(filter);
      if (deleteResult !== undefined) {
        return { acknowledged: true, deletedCount: deleteResult };
      }
      const index = records.findIndex(
        (record) =>
          record._id.equals(filter._id) && record.ownerId === filter.ownerId,
      );
      if (index < 0) return { acknowledged: true, deletedCount: 0 };
      records.splice(index, 1);
      return { acknowledged: true, deletedCount: 1 };
    },
  };

  return {
    calls,
    records,
    bookingRecords,
    collectionName: undefined,
    collection(name) {
      this.collectionName = name;
      selectedCollectionName = name;
      return collection;
    },
  };
}

async function withServer(
  database,
  run,
  { authenticate = createTestAuthenticate() } = {},
) {
  const app = createApp({
    registerRoutes: (expressApp) =>
      registerStudioRoutes(expressApp, {
        getDatabase: () => database,
        authenticate,
      }),
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

test("POST /api/studios inserts one public studio and derives its owner from BetterAuth", async () => {
  const database = createMockDatabase();
  await withServer(
    database,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/studios`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validStudioPayload()),
      });
      const body = await response.json();
      const [stored] = database.calls.insertedDocuments;

      assert.equal(response.status, 201);
      assert.equal(database.calls.insertedDocuments.length, 1);
      assert.equal(database.collectionName, "studios");
      assert.deepEqual(body, {
        success: true,
        message: "Studio created successfully",
        data: {
          id: String(stored._id),
          title: "Daylight Photo Studio",
          slug: stored.slug,
          category: "Photo Studios",
          categorySlug: "photo-studios",
          hourlyRate: 95,
          securityDeposit: 150,
          capacity: 8,
          location: "Brooklyn, New York",
          image: "https://images.example.test/daylight-studio.jpg",
          imageAlt: "A bright photography studio",
          amenities: ["Natural light", "Backdrop", "changing area"],
          overview:
            "A bright, flexible studio with room for portrait sessions and small productions.",
          createdAt: stored.createdAt.toISOString(),
          reviewCount: 0,
          host: {
            name: authenticatedUser.name,
            avatar: authenticatedUser.image,
          },
        },
      });
      assert.match(stored.slug, /^daylight-photo-studio-[\da-f]{24}$/);
      assert.equal(stored.ownerId, authenticatedUser.id);
      assert.equal(stored.ownerEmail, "creator@example.test");
      assert.equal(stored.ownerName, authenticatedUser.name);
      assert.equal(stored.host.name, authenticatedUser.name);
      assert.equal(stored.host.avatar, authenticatedUser.image);
      assert.equal(stored.reviewCount, 0);
      assert.ok(stored._id instanceof ObjectId);
      assert.ok(stored.createdAt instanceof Date);
      assert.equal(stored.updatedAt, stored.createdAt);
      assert.equal("ownerEmail" in body.data, false);
      assert.equal("ownerId" in body.data, false);
      assert.equal("ownerName" in body.data, false);
      assert.equal("_id" in body.data, false);
      assert.equal("rating" in body.data, false);
    },
    { authenticate: createTestAuthenticate() },
  );
});

test("POST /api/studios ignores client-supplied ownership and server-managed fields", async () => {
  const database = createMockDatabase();
  await withServer(
    database,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/studios`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          validStudioPayload({
            category: "Conflicting Client Category",
            slug: "client-slug",
            _id: "client-id",
            ownerId: "attacker-id",
            ownerEmail: "attacker@example.test",
            ownerName: "Attacker",
            host: { name: "Attacker", avatar: "javascript:alert(1)" },
            createdAt: "2000-01-01T00:00:00.000Z",
            updatedAt: "2000-01-01T00:00:00.000Z",
            rating: 5,
            reviewCount: 999,
          }),
        ),
      });
      const [stored] = database.calls.insertedDocuments;

      assert.equal(response.status, 201);
      assert.equal(stored.category, "Photo Studios");
      assert.notEqual(stored.slug, "client-slug");
      assert.notEqual(String(stored._id), "client-id");
      assert.equal(stored.ownerId, authenticatedUser.id);
      assert.equal(stored.ownerEmail, "creator@example.test");
      assert.equal(stored.ownerName, authenticatedUser.name);
      assert.deepEqual(stored.host, {
        name: authenticatedUser.name,
        avatar: authenticatedUser.image,
      });
      assert.ok(stored.createdAt > new Date("2000-01-01T00:00:00.000Z"));
      assert.equal(stored.reviewCount, 0);
      assert.equal("rating" in stored, false);
    },
    { authenticate: createTestAuthenticate() },
  );
});

test("POST /api/studios stores the canonical display label for every category", async (t) => {
  for (const [categorySlug, category] of [
    ["photo-studios", "Photo Studios"],
    ["sound-stages", "Sound Stages"],
    ["podcast-rooms", "Podcast Rooms"],
    ["music-suites", "Music Suites"],
    ["art-workshops", "Art Workshops"],
  ]) {
    await t.test(categorySlug, async () => {
      const database = createMockDatabase();
      await withServer(
        database,
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}/api/studios`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(validStudioPayload({ categorySlug })),
          });
          assert.equal(response.status, 201);
          assert.equal(database.calls.insertedDocuments[0].category, category);
          assert.equal(
            database.calls.insertedDocuments[0].categorySlug,
            categorySlug,
          );
        },
        { authenticate: createTestAuthenticate() },
      );
    });
  }
});

test("POST /api/studios generates distinct ObjectId-backed slugs", async () => {
  const database = createMockDatabase();
  await withServer(
    database,
    async (baseUrl) => {
      const createStudio = () =>
        fetch(`${baseUrl}/api/studios`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(validStudioPayload()),
        });
      const firstResponse = await createStudio();
      const secondResponse = await createStudio();
      const first = await firstResponse.json();
      const second = await secondResponse.json();

      assert.equal(firstResponse.status, 201);
      assert.equal(secondResponse.status, 201);
      assert.notEqual(first.data.slug, second.data.slug);
      assert.notEqual(first.data.id, second.data.id);
      assert.match(first.data.slug, /^daylight-photo-studio-[\da-f]{24}$/);
      assert.match(second.data.slug, /^daylight-photo-studio-[\da-f]{24}$/);
    },
    { authenticate: createTestAuthenticate() },
  );
});

test("POST /api/studios accepts HTTP image URLs", async () => {
  const database = createMockDatabase();
  await withServer(
    database,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/studios`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          validStudioPayload({ image: "http://images.example.test/studio.jpg" }),
        ),
      });
      assert.equal(response.status, 201);
      assert.equal(
        database.calls.insertedDocuments[0].image,
        "http://images.example.test/studio.jpg",
      );
    },
    { authenticate: createTestAuthenticate() },
  );
});

test("POST /api/studios rejects invalid studio fields with VALIDATION_ERROR", async (t) => {
  const invalidPayloads = [
    ["missing required title", (() => {
      const payload = validStudioPayload();
      delete payload.title;
      return payload;
    })()],
    ["blank title", validStudioPayload({ title: "  " })],
    ["short title", validStudioPayload({ title: "Ab" })],
    ["nested title", validStudioPayload({ title: { text: "Studio" } })],
    ["long title", validStudioPayload({ title: "x".repeat(101) })],
    ["unsupported category", validStudioPayload({ categorySlug: "events" })],
    ["non-number rate", validStudioPayload({ hourlyRate: "95" })],
    ["zero rate", validStudioPayload({ hourlyRate: 0 })],
    ["negative rate", validStudioPayload({ hourlyRate: -1 })],
    [
      "infinite rate",
      JSON.stringify(validStudioPayload()).replace(
        '"hourlyRate":95',
        '"hourlyRate":1e309',
      ),
    ],
    ["negative deposit", validStudioPayload({ securityDeposit: -1 })],
    ["non-number deposit", validStudioPayload({ securityDeposit: null })],
    ["fractional capacity", validStudioPayload({ capacity: 2.5 })],
    ["zero capacity", validStudioPayload({ capacity: 0 })],
    ["invalid location type", validStudioPayload({ location: [] })],
    ["blank location", validStudioPayload({ location: " " })],
    ["long location", validStudioPayload({ location: "x".repeat(161) })],
    ["invalid image URL", validStudioPayload({ image: "not a URL" })],
    ["unsupported image protocol", validStudioPayload({ image: "ftp://example.test/a.jpg" })],
    ["non-string image alt", validStudioPayload({ imageAlt: { alt: "studio" } })],
    ["long image alt", validStudioPayload({ imageAlt: "x".repeat(251) })],
    ["empty amenity", validStudioPayload({ amenities: [" "] })],
    ["long amenity", validStudioPayload({ amenities: ["x".repeat(81)] })],
    ["nested amenity", validStudioPayload({ amenities: [{ name: "Light" }] })],
    ["too many amenities", validStudioPayload({ amenities: Array(21).fill("Item") })],
    ["short overview", validStudioPayload({ overview: "Too short" })],
    ["long overview", validStudioPayload({ overview: "x".repeat(2001) })],
    ["nested overview", validStudioPayload({ overview: { text: "description" } })],
    ["unexpected input", validStudioPayload({ internalRole: "admin" })],
  ];

  for (const [name, payload] of invalidPayloads) {
    await t.test(name, async () => {
      const database = createMockDatabase();
      await withServer(
        database,
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}/api/studios`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: typeof payload === "string" ? payload : JSON.stringify(payload),
          });
          const body = await response.json();
          assert.equal(response.status, 400);
          assert.equal(body.success, false);
          assert.equal(body.code, "VALIDATION_ERROR");
          assert.equal(body.details, null);
          assert.equal(database.calls.insertedDocuments.length, 0);
        },
        { authenticate: createTestAuthenticate() },
      );
    });
  }

  await t.test("non-object body", async () => {
    const database = createMockDatabase();
    await withServer(
      database,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/studios`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify([]),
        });
        const body = await response.json();
        assert.equal(response.status, 400);
        assert.equal(body.code, "VALIDATION_ERROR");
        assert.equal(database.calls.insertedDocuments.length, 0);
      },
      { authenticate: createTestAuthenticate() },
    );
  });
});

test("POST /api/studios rejects incomplete verified identities", async () => {
  const database = createMockDatabase();
  await withServer(
    database,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/studios`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validStudioPayload()),
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, "AUTH_USER_INCOMPLETE");
      assert.equal(database.calls.insertedDocuments.length, 0);
    },
    {
      authenticate: createTestAuthenticate({
        user: { id: "user-id", email: "", name: "" },
      }),
    },
  );
});

test("POST /api/studios rejects middleware without a verified identity", async () => {
  const database = createMockDatabase();
  await withServer(
    database,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/studios`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validStudioPayload()),
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, "AUTH_USER_INCOMPLETE");
      assert.equal(database.calls.insertedDocuments.length, 0);
    },
    { authenticate: (_request, _response, next) => next() },
  );
});

test("POST /api/studios returns 503 when MongoDB is unavailable", async () => {
  await withServer(
    null,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/studios`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validStudioPayload()),
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        success: false,
        message: "Database is not available",
        code: "DATABASE_NOT_READY",
        details: null,
      });
    },
    { authenticate: createTestAuthenticate() },
  );
});

test("POST /api/studios insert failures use the standard safe error response", async () => {
  const database = createMockDatabase({
    insertError: new Error("private MongoDB connection detail"),
  });
  await withServer(
    database,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/studios`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validStudioPayload()),
      });
      const body = await response.json();
      assert.equal(response.status, 500);
      assert.equal(body.code, "INTERNAL_SERVER_ERROR");
      assert.equal(body.message, "An unexpected server error occurred");
      assert.equal(JSON.stringify(body).includes("private MongoDB"), false);
    },
    { authenticate: createTestAuthenticate() },
  );
});

test("a created studio is immediately retrievable by slug and ObjectId", async () => {
  const database = createMockDatabase();
  await withServer(
    database,
    async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/api/studios`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validStudioPayload()),
      });
      const created = await createResponse.json();
      assert.equal(createResponse.status, 201);

      const bySlug = await fetch(`${baseUrl}/api/studios/${created.data.slug}`);
      const byId = await fetch(`${baseUrl}/api/studios/${created.data.id}`);
      const slugResult = await bySlug.json();
      const idResult = await byId.json();

      assert.equal(bySlug.status, 200);
      assert.equal(byId.status, 200);
      assert.equal(slugResult.data.id, created.data.id);
      assert.equal(idResult.data.slug, created.data.slug);
      assert.equal("ownerEmail" in slugResult.data, false);
      assert.equal("ownerEmail" in idResult.data, false);
    },
    { authenticate: createTestAuthenticate() },
  );
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

test("GET /api/studios/:id exposes only valid public reviews and derives rating metadata", async () => {
  const record = {
    ...baseRecord(),
    rating: 1,
    reviewCount: 900,
    reviews: [
      {
        _id: new ObjectId("65c7a6b0c9d2fddc4493e101"),
        name: "  Creative Guest  ",
        rating: 5,
        date: new Date("2025-01-02T03:04:05.000Z"),
        text: "  Excellent natural light and a very helpful host.  ",
        userId: "private-user-id",
        email: "private@example.test",
        ownerId: "private-owner-id",
      },
      {
        name: "Invalid rating",
        rating: 8,
        text: "This review must not be exposed.",
      },
      {
        name: "private-reviewer@example.test",
        rating: 5,
        text: "This review must not expose an email as its public name.",
        email: "private-reviewer@example.test",
      },
      {
        name: "Missing text",
        rating: 5,
      },
    ],
  };
  const database = createMockDatabase({ detail: record });

  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios/${record._id}`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.data.reviews, [
      {
        id: "65c7a6b0c9d2fddc4493e101",
        name: "Creative Guest",
        rating: 5,
        date: "2025-01-02T03:04:05.000Z",
        text: "Excellent natural light and a very helpful host.",
      },
      {
        rating: 5,
        text: "This review must not expose an email as its public name.",
      },
    ]);
    assert.equal(body.data.rating, 5);
    assert.equal(body.data.reviewCount, 2);
    assert.equal("email" in body.data.reviews[0], false);
    assert.equal("userId" in body.data.reviews[0], false);
    assert.equal("ownerId" in body.data.reviews[0], false);
    assert.equal("name" in body.data.reviews[1], false);
    assert.equal(body.data.reviews[1].name, undefined);
    assert.equal("email" in body.data.reviews[1], false);
    assert.equal("ownerEmail" in body.data, false);
    assert.equal("passwordHash" in body.data, false);
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

test("GET /api/studios/mine rejects unauthenticated access", async () => {
  await withServer(
    createMockDatabase(),
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/studios/mine`);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), {
        success: false,
        message: "Authentication is required",
        code: "UNAUTHENTICATED",
        details: null,
      });
    },
    {
      authenticate: (_request, response) => {
        response.status(401).json({
          success: false,
          message: "Authentication is required",
          code: "UNAUTHENTICATED",
          details: null,
        });
      },
    },
  );
});

test("GET /api/studios/mine returns only studios owned by the authenticated user", async () => {
  const ownerRecord = {
    ...baseRecord(),
    _id: new ObjectId("65c7a6b0c9d2fddc4493e002"),
    ownerId: "better-auth-user-123",
    slug: "my-studio",
  };
  const otherRecord = {
    ...baseRecord(),
    _id: new ObjectId("65c7a6b0c9d2fddc4493e003"),
    ownerId: "different-user-456",
    slug: "other-studio",
  };
  const database = createMockDatabase({ records: [ownerRecord, otherRecord] });
  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios/mine`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.deepEqual(database.calls.find.filter, { ownerId: "better-auth-user-123" });
    assert.equal(Array.isArray(body.data), true);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].id, String(ownerRecord._id));
    assert.equal(body.data[0].slug, ownerRecord.slug);
  });
});

test("GET /api/studios/mine does not expose another user's studios", async () => {
  const otherRecord = {
    ...baseRecord(),
    _id: new ObjectId("65c7a6b0c9d2fddc4493e004"),
    ownerId: "another-user-999",
  };
  const database = createMockDatabase({ records: [otherRecord] });
  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios/mine`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.length, 0);
  });
});

test("GET /api/studios/mine returns empty array when owner has no studios", async () => {
  const database = createMockDatabase({ records: [] });
  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios/mine`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.data, []);
  });
});

test("PATCH /api/studios/:id rejects unauthenticated update", async () => {
  const record = baseRecord();
  record.ownerId = "better-auth-user-123";
  const database = createMockDatabase({ records: [record] });
  await withServer(
    database,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/studios/${record._id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Updated Title" }),
      });
      assert.equal(response.status, 401);
    },
    {
      authenticate: (_request, response) => {
        response.status(401).json({
          success: false,
          message: "Authentication is required",
          code: "UNAUTHENTICATED",
          details: null,
        });
      },
    },
  );
});

test("PATCH /api/studios/:id allows owner to update their studio", async () => {
  const record = baseRecord();
  record.ownerId = "better-auth-user-123";
  const database = createMockDatabase({ records: [record] });
  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios/${record._id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Updated Studio Name" }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.data.title, "Updated Studio Name");
    assert.equal(record.title, "Updated Studio Name");
  });
});

test("PATCH /api/studios/:id rejects non-owner updates", async () => {
  const record = baseRecord();
  record.ownerId = "owner-123";
  const database = createMockDatabase({ records: [record] });
  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios/${record._id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Hacked Title" }),
    });
    assert.equal(response.status, 403);
  });
});

test("PATCH /api/studios/:id returns 404 for missing studio", async () => {
  const database = createMockDatabase({ records: [] });
  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios/65c7a6b0c9d2fddc4493e999`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Updated Title" }),
    });
    assert.equal(response.status, 404);
  });
});

test("PATCH /api/studios/:id rejects invalid fields", async () => {
  const record = baseRecord();
  record.ownerId = "better-auth-user-123";
  const database = createMockDatabase({ records: [record] });
  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios/${record._id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "ab" }),
    });
    assert.equal(response.status, 400);
  });
});

test("PATCH /api/studios/:id prevents changing protected ownership fields", async () => {
  const record = baseRecord();
  record.ownerId = "better-auth-user-123";
  const database = createMockDatabase({ records: [record] });
  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios/${record._id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerId: "hacker" }),
    });
    assert.equal(response.status, 400);
  });
});

test("DELETE /api/studios/:id lets the owner delete exactly one studio by ObjectId", async () => {
  const record = { ...baseRecord(), ownerId: authenticatedUser.id };
  const otherRecord = {
    ...baseRecord(),
    _id: new ObjectId("65c7a6b0c9d2fddc4493e005"),
    ownerId: "another-user",
  };
  const database = createMockDatabase({ records: [record, otherRecord] });

  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios/${record._id}`, {
      method: "DELETE",
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      message: "Studio deleted successfully",
      data: { id: String(record._id) },
    });
    assert.deepEqual(database.calls.deleteOne, [
      { _id: record._id, ownerId: authenticatedUser.id },
    ]);
    assert.deepEqual(database.calls.findOneCalls[0], {
      collection: "studios",
      filter: { _id: record._id },
    });
    assert.deepEqual(database.records, [otherRecord]);
  });
});

test("DELETE /api/studios/:id supports an owned studio slug", async () => {
  const record = {
    ...baseRecord(),
    ownerId: authenticatedUser.id,
    slug: "daylight-studio",
  };
  const database = createMockDatabase({ records: [record] });

  await withServer(database, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/studios/${record.slug}`,
      { method: "DELETE" },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(database.calls.findOneCalls[0], {
      collection: "studios",
      filter: { slug: record.slug },
    });
    assert.equal(database.calls.deleteOne.length, 1);
  });
});

test("DELETE /api/studios/:id rejects a non-owner without deleting the studio", async () => {
  const record = { ...baseRecord(), ownerId: "another-user" };
  const database = createMockDatabase({ records: [record] });

  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios/${record._id}`, {
      method: "DELETE",
    });

    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "FORBIDDEN");
    assert.equal(database.calls.deleteOne.length, 0);
    assert.equal(database.calls.findOne.filter._id.equals(record._id), true);
    assert.deepEqual(database.records, [record]);
  });
});

test("DELETE /api/studios/:id rejects unauthenticated requests", async () => {
  const record = { ...baseRecord(), ownerId: authenticatedUser.id };
  const database = createMockDatabase({ records: [record] });

  await withServer(
    database,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/studios/${record._id}`, {
        method: "DELETE",
      });

      assert.equal(response.status, 401);
      assert.equal(database.calls.deleteOne.length, 0);
    },
    {
      authenticate: (_request, response) => {
        response.status(401).json({
          success: false,
          message: "Authentication is required",
          code: "UNAUTHENTICATED",
          details: null,
        });
      },
    },
  );
});

test("DELETE /api/studios/:id returns 404 for unknown and malformed identifiers", async () => {
  const database = createMockDatabase({ records: [] });

  await withServer(database, async (baseUrl) => {
    const missingResponse = await fetch(
      `${baseUrl}/api/studios/65c7a6b0c9d2fddc4493e999`,
      { method: "DELETE" },
    );
    const malformedResponse = await fetch(
      `${baseUrl}/api/studios/not%20a%20valid%20slug`,
      { method: "DELETE" },
    );

    assert.equal(missingResponse.status, 404);
    assert.equal(malformedResponse.status, 404);
    assert.equal(database.calls.deleteOne.length, 0);
  });
});

test("DELETE /api/studios/:id returns 503 when the database is unavailable", async () => {
  await withServer(null, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/studios/65c7a6b0c9d2fddc4493e001`,
      { method: "DELETE" },
    );

    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "DATABASE_NOT_READY");
  });
});

test("DELETE /api/studios/:id preserves studios with booking history", async () => {
  const record = { ...baseRecord(), ownerId: authenticatedUser.id };
  const booking = {
    _id: new ObjectId(),
    studioId: String(record._id),
    status: "Cancelled",
  };
  const database = createMockDatabase({
    records: [record],
    bookingRecords: [booking],
  });

  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios/${record._id}`, {
      method: "DELETE",
    });

    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "STUDIO_HAS_BOOKINGS");
    assert.equal(database.calls.deleteOne.length, 0);
    assert.equal(database.collectionName, "bookings");
    assert.deepEqual(database.records, [record]);
    assert.deepEqual(database.bookingRecords, [booking]);
    assert.equal(booking.studioId, String(record._id));
    assert.equal(booking.status, "Cancelled");
    assert.equal(record.ownerId, authenticatedUser.id);
  });
});

test("DELETE /api/studios/:id never reports success when MongoDB deletes no document", async () => {
  const record = { ...baseRecord(), ownerId: authenticatedUser.id };
  const database = createMockDatabase({
    records: [record],
    deleteResult: 0,
  });

  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/studios/${record._id}`, {
      method: "DELETE",
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.success, false);
    assert.equal(body.code, "STUDIO_NOT_FOUND");
    assert.equal(database.calls.deleteOne.length, 1);
  });
});
