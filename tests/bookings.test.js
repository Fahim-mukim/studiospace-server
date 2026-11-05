import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ObjectId } from "mongodb";
import { registerStudioRoutes } from "../index.js";
import { createApp } from "../src/app.js";

const servers = [];
const authenticatedUser = {
  id: "verified-user-123",
  email: " Verified.User@Example.Test ",
  name: "Verified User",
};
const studioId = new ObjectId("65c7a6b0c9d2fddc4493e001");

function createStudio(overrides = {}) {
  return {
    _id: new ObjectId(studioId),
    slug: "daylight-studio",
    title: "Daylight Studio",
    image: "https://example.test/studio.jpg",
    location: "Brooklyn",
    hourlyRate: 87.5,
    ...overrides,
  };
}

function createBooking(overrides = {}) {
  return {
    _id: new ObjectId(),
    studioId: String(studioId),
    userId: authenticatedUser.id,
    userEmail: authenticatedUser.email.trim().toLowerCase(),
    userName: authenticatedUser.name,
    bookingDate: "2030-01-02",
    startTime: "10:00",
    endTime: "12:00",
    startAt: new Date("2030-01-02T10:00:00"),
    endAt: new Date("2030-01-02T12:00:00"),
    duration: 2,
    hourlyRateSnapshot: 87.5,
    totalAmount: 175,
    status: "Pending",
    createdAt: new Date("2030-01-01T10:00:00"),
    updatedAt: new Date("2030-01-01T10:00:00"),
    ...overrides,
  };
}

function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function futureDate(daysAhead = 2) {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  return localDateString(date);
}

function validRequest(overrides = {}) {
  return {
    studioId: String(studioId),
    bookingDate: futureDate(),
    startTime: "10:00",
    endTime: "12:00",
    ...overrides,
  };
}

function createTestAuthenticate(user = authenticatedUser) {
  return (request, _response, next) => {
    request.user = user;
    next();
  };
}

function createBookingMockDatabase({ studios = [], bookings = [] } = {}) {
  const calls = {
    findOne: [],
    find: [],
    insertedDocuments: [],
    updateOne: [],
  };
  const documents = { studios, bookings };

  function matches(record, filter) {
    return Object.entries(filter).every(([key, condition]) => {
      if (key === "$or") {
        return condition.some((clause) =>
          Object.entries(clause).every(([field, comparison]) =>
            matches(record, { [field]: comparison }),
          ),
        );
      }

      const actual = record[key];
      if (
        condition &&
        typeof condition === "object" &&
        !condition._bsontype &&
        !Array.isArray(condition) &&
        !(condition instanceof Date)
      ) {
        return Object.entries(condition).every(([operator, expected]) => {
          if (operator === "$lt") return actual < expected;
          if (operator === "$gt") return actual > expected;
          return false;
        });
      }
      if (actual instanceof ObjectId && condition instanceof ObjectId) {
        return actual.equals(condition);
      }
      return actual === condition;
    });
  }

  return {
    calls,
    collection(name) {
      assert.ok(Object.hasOwn(documents, name), `Unexpected collection ${name}`);
      const records = documents[name];

      return {
        async findOne(filter) {
          calls.findOne.push({ collection: name, filter });
          return records.find((record) => matches(record, filter)) ?? null;
        },
        find(filter = {}) {
          calls.find.push({ collection: name, filter });
          const result = records.filter((record) => matches(record, filter));
          return {
            sort(sortSpec) {
              const [[field, direction]] = Object.entries(sortSpec);
              result.sort((left, right) => {
                const leftValue = left[field] instanceof Date
                  ? left[field].getTime()
                  : left[field];
                const rightValue = right[field] instanceof Date
                  ? right[field].getTime()
                  : right[field];
                return (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0) * direction;
              });
              return this;
            },
            async toArray() {
              return result;
            },
          };
        },
        async insertOne(document) {
          calls.insertedDocuments.push({ collection: name, document });
          records.push(document);
          return { acknowledged: true, insertedId: document._id };
        },
        async updateOne(filter, update) {
          calls.updateOne.push({ collection: name, filter, update });
          const record = records.find((candidate) => matches(candidate, filter));
          if (record && update?.$set) Object.assign(record, update.$set);
          return {
            acknowledged: true,
            matchedCount: record ? 1 : 0,
            modifiedCount: record ? 1 : 0,
          };
        },
      };
    },
  };
}

async function withServer(
  database,
  run,
  {
    authenticate = createTestAuthenticate(),
  } = {},
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

async function postBooking(baseUrl, body) {
  return fetch(`${baseUrl}/api/bookings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function assertInvalidBooking(body, database = createBookingMockDatabase({
  studios: [createStudio()],
})) {
  await withServer(database, async (baseUrl) => {
    const response = await postBooking(baseUrl, body);
    assert.equal(response.status, 400);
    assert.equal(database.calls.insertedDocuments.length, 0);
  });
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

test("POST /api/bookings creates an ObjectId booking from verified identity and stored studio data", async () => {
  const studio = createStudio();
  const database = createBookingMockDatabase({ studios: [studio] });

  await withServer(database, async (baseUrl) => {
    const response = await postBooking(baseUrl, {
      ...validRequest(),
      userId: "attacker-user",
      userEmail: "attacker@example.test",
      userName: "Attacker",
      status: "Confirmed",
      totalAmount: 0.01,
      hourlyRate: 0.01,
      hourlyRateSnapshot: 0.01,
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.success, true);
    assert.equal(body.data.status, "Pending");

    const inserted = database.calls.insertedDocuments[0].document;
    assert.equal(database.calls.insertedDocuments.length, 1);
    assert.equal(inserted.studioId, String(studio._id));
    assert.equal(inserted.userId, authenticatedUser.id);
    assert.equal(inserted.userEmail, "verified.user@example.test");
    assert.equal(inserted.userName, authenticatedUser.name);
    assert.equal(inserted.hourlyRateSnapshot, studio.hourlyRate);
    assert.equal(inserted.duration, 2);
    assert.equal(inserted.totalAmount, 175);
    assert.equal(inserted.status, "Pending");
    assert.equal(inserted.startAt.getTime(), new Date(`${body.data.bookingDate}T10:00`).getTime());
    assert.equal(inserted.endAt.getTime(), new Date(`${body.data.bookingDate}T12:00`).getTime());
    assert.notEqual(body.data.totalAmount, 0.01);
    assert.notEqual(body.data.userId, "attacker-user");
  });
});

test("POST /api/bookings looks up a studio by slug", async () => {
  const studio = createStudio();
  const database = createBookingMockDatabase({ studios: [studio] });

  await withServer(database, async (baseUrl) => {
    const response = await postBooking(
      baseUrl,
      validRequest({ studioId: studio.slug }),
    );
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.data.studioId, String(studio._id));
    assert.deepEqual(
      database.calls.findOne.find((call) => call.collection === "studios").filter,
      { slug: studio.slug },
    );
  });
});

test("POST /api/bookings returns 404 for an unknown studio", async () => {
  const database = createBookingMockDatabase();
  await withServer(database, async (baseUrl) => {
    const response = await postBooking(baseUrl, validRequest());
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "STUDIO_NOT_FOUND");
    assert.equal(database.calls.insertedDocuments.length, 0);
  });
});

test("POST /api/bookings returns 400 when studioId is missing", async () => {
  await assertInvalidBooking(validRequest({ studioId: undefined }));
});

test("POST /api/bookings returns 400 when bookingDate is missing", async () => {
  await assertInvalidBooking(validRequest({ bookingDate: undefined }));
});

test("POST /api/bookings returns 400 when startTime is missing", async () => {
  await assertInvalidBooking(validRequest({ startTime: undefined }));
});

test("POST /api/bookings returns 400 when endTime is missing", async () => {
  await assertInvalidBooking(validRequest({ endTime: undefined }));
});

test("POST /api/bookings returns 400 for an invalid booking date", async () => {
  await assertInvalidBooking(validRequest({ bookingDate: "not-a-date" }));
});

test("POST /api/bookings returns 400 for an invalid booking time", async () => {
  await assertInvalidBooking(validRequest({ startTime: "25:00" }));
});

test("POST /api/bookings rejects past booking starts", async () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  await assertInvalidBooking(
    validRequest({
      bookingDate: localDateString(yesterday),
      startTime: "10:00",
      endTime: "12:00",
    }),
  );
});

test("POST /api/bookings rejects equal start and end times", async () => {
  await assertInvalidBooking(validRequest({ startTime: "10:00", endTime: "10:00" }));
});

test("POST /api/bookings rejects end times before start times", async () => {
  await assertInvalidBooking(validRequest({ startTime: "12:00", endTime: "10:00" }));
});

const longDurationDate = (() => {
  const candidate = new Date();
  for (let day = 1; day <= 370; day += 1) {
    candidate.setDate(candidate.getDate() + 1);
    const date = localDateString(candidate);
    const start = new Date(`${date}T00:00`);
    const end = new Date(`${date}T23:59`);
    if (end.getTime() - start.getTime() > 24 * 60 * 60 * 1000) {
      return date;
    }
  }
  return null;
})();

test(
  "POST /api/bookings rejects a duration over 24 hours on a local clock-change day",
  { skip: longDurationDate ? false : "The local timezone has no 25-hour date in the next year." },
  async () => {
    await assertInvalidBooking(
      validRequest({
        bookingDate: longDurationDate,
        startTime: "00:00",
        endTime: "23:59",
      }),
    );
  },
);

test("POST /api/bookings returns 409 and inserts nothing for an overlapping Confirmed booking", async () => {
  const bookingDate = futureDate();
  const confirmed = createBooking({
    bookingDate,
    startTime: "11:00",
    endTime: "13:00",
    startAt: new Date(`${bookingDate}T11:00`),
    endAt: new Date(`${bookingDate}T13:00`),
    status: "Confirmed",
  });
  const database = createBookingMockDatabase({
    studios: [createStudio()],
    bookings: [confirmed],
  });

  await withServer(database, async (baseUrl) => {
    const response = await postBooking(baseUrl, validRequest({ bookingDate }));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "BOOKING_CONFLICT");
    assert.equal(database.calls.insertedDocuments.length, 0);

    const overlapQuery = database.calls.findOne.find(
      (call) => call.collection === "bookings",
    ).filter;
    assert.deepEqual(overlapQuery.$or, [
      {
        startAt: { $lt: new Date(`${bookingDate}T12:00`) },
        endAt: { $gt: new Date(`${bookingDate}T10:00`) },
      },
    ]);
  });
});

test("POST /api/bookings accepts a non-overlapping Confirmed booking", async () => {
  const bookingDate = futureDate();
  const confirmed = createBooking({
    bookingDate,
    startTime: "13:00",
    endTime: "14:00",
    startAt: new Date(`${bookingDate}T13:00`),
    endAt: new Date(`${bookingDate}T14:00`),
    status: "Confirmed",
  });
  const database = createBookingMockDatabase({
    studios: [createStudio()],
    bookings: [confirmed],
  });

  await withServer(database, async (baseUrl) => {
    const response = await postBooking(baseUrl, validRequest({ bookingDate }));
    assert.equal(response.status, 201);
    assert.equal(database.calls.insertedDocuments.length, 1);
  });
});

test("POST /api/bookings does not block an overlapping Pending booking", async () => {
  const bookingDate = futureDate();
  const pending = createBooking({
    bookingDate,
    startTime: "11:00",
    endTime: "13:00",
    startAt: new Date(`${bookingDate}T11:00`),
    endAt: new Date(`${bookingDate}T13:00`),
    status: "Pending",
  });
  const database = createBookingMockDatabase({
    studios: [createStudio()],
    bookings: [pending],
  });

  await withServer(database, async (baseUrl) => {
    const response = await postBooking(baseUrl, validRequest({ bookingDate }));
    assert.equal(response.status, 201);
    assert.equal(database.calls.insertedDocuments.length, 1);
  });
});

test("POST /api/bookings accepts adjacent time windows", async () => {
  const bookingDate = futureDate();
  const adjacent = createBooking({
    bookingDate,
    startTime: "08:00",
    endTime: "10:00",
    startAt: new Date(`${bookingDate}T08:00`),
    endAt: new Date(`${bookingDate}T10:00`),
    status: "Confirmed",
  });
  const database = createBookingMockDatabase({
    studios: [createStudio()],
    bookings: [adjacent],
  });

  await withServer(database, async (baseUrl) => {
    const response = await postBooking(baseUrl, validRequest({ bookingDate }));
    assert.equal(response.status, 201);
    assert.equal(database.calls.insertedDocuments.length, 1);
  });
});

test("GET /api/bookings/mine returns only verified-user bookings sorted newest first", async () => {
  const newest = createBooking({
    _id: new ObjectId(),
    createdAt: new Date("2030-01-03T10:00:00"),
  });
  const oldest = createBooking({
    _id: new ObjectId(),
    createdAt: new Date("2030-01-01T10:00:00"),
  });
  const otherUser = createBooking({
    _id: new ObjectId(),
    userId: "other-user",
    createdAt: new Date("2030-01-04T10:00:00"),
  });
  const database = createBookingMockDatabase({
    bookings: [oldest, otherUser, newest],
  });

  await withServer(database, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/bookings/mine?userId=other-user`,
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(database.calls.find, [
      { collection: "bookings", filter: { userId: authenticatedUser.id } },
    ]);
    assert.deepEqual(body.data.map((booking) => booking.id), [
      String(newest._id),
      String(oldest._id),
    ]);
    assert.equal(body.data.some((booking) => booking.userId === "other-user"), false);
  });
});

test("GET /api/bookings/mine returns an empty array when the verified user has no bookings", async () => {
  const database = createBookingMockDatabase({
    bookings: [
      createBooking({ userId: "another-user" }),
    ],
  });
  await withServer(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/bookings/mine`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, []);
    assert.deepEqual(database.calls.find[0].filter, {
      userId: authenticatedUser.id,
    });
  });
});

test("PATCH /api/bookings/:id/cancel cancels an owned Pending booking", async () => {
  const booking = createBooking({
    _id: new ObjectId(),
    updatedAt: new Date("2020-01-01T00:00:00"),
  });
  const previousUpdatedAt = booking.updatedAt;
  const database = createBookingMockDatabase({ bookings: [booking] });

  await withServer(database, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/bookings/${booking._id}/cancel`,
      { method: "PATCH" },
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(booking.status, "Cancelled");
    assert.ok(booking.updatedAt > previousUpdatedAt);
    assert.deepEqual(database.calls.updateOne[0].update, {
      $set: { status: "Cancelled", updatedAt: booking.updatedAt },
    });
  });
});

test("PATCH /api/bookings/:id/cancel rejects another user's booking without modifying it", async () => {
  const booking = createBooking({
    _id: new ObjectId(),
    userId: "different-user",
  });
  const previousUpdatedAt = booking.updatedAt;
  const database = createBookingMockDatabase({ bookings: [booking] });

  await withServer(database, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/bookings/${booking._id}/cancel`,
      { method: "PATCH" },
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "FORBIDDEN");
    assert.equal(booking.status, "Pending");
    assert.equal(booking.updatedAt, previousUpdatedAt);
    assert.equal(database.calls.updateOne.length, 0);
  });
});

for (const status of ["Confirmed", "Completed", "Cancelled", "Draft"]) {
  test(`PATCH /api/bookings/:id/cancel rejects ${status} bookings`, async () => {
    const booking = createBooking({ _id: new ObjectId(), status });
    const previousUpdatedAt = booking.updatedAt;
    const database = createBookingMockDatabase({ bookings: [booking] });

    await withServer(database, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/bookings/${booking._id}/cancel`,
        { method: "PATCH" },
      );
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "INVALID_BOOKING_STATUS");
      assert.equal(booking.status, status);
      assert.equal(booking.updatedAt, previousUpdatedAt);
      assert.equal(database.calls.updateOne.length, 0);
    });
  });
}

test("PATCH /api/bookings/:id/cancel returns 404 for a malformed ID", async () => {
  const database = createBookingMockDatabase();
  await withServer(database, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/bookings/not-an-object-id/cancel`,
      { method: "PATCH" },
    );
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "BOOKING_NOT_FOUND");
    assert.equal(database.calls.findOne.length, 0);
  });
});

test("PATCH /api/bookings/:id/cancel returns 404 for an unknown valid ID", async () => {
  const database = createBookingMockDatabase();
  await withServer(database, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/bookings/65c7a6b0c9d2fddc4493e999/cancel`,
      { method: "PATCH" },
    );
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "BOOKING_NOT_FOUND");
  });
});

for (const [method, path, body] of [
  ["POST", "/api/bookings", validRequest()],
  ["GET", "/api/bookings/mine"],
  ["PATCH", `/api/bookings/${new ObjectId()}/cancel`],
]) {
  test(`${method} ${path.split("?")[0]} rejects unauthenticated requests`, async () => {
    const database = createBookingMockDatabase({
      studios: [createStudio()],
      bookings: [createBooking()],
    });
    const authenticate = (_request, response) =>
      response.status(401).json({
        success: false,
        message: "Authentication is required",
        code: "UNAUTHENTICATED",
        details: null,
      });

    await withServer(
      database,
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          ...(body
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }
            : {}),
        });
        assert.equal(response.status, 401);
        assert.equal((await response.json()).code, "UNAUTHENTICATED");
        assert.equal(database.calls.insertedDocuments.length, 0);
        assert.equal(database.calls.updateOne.length, 0);
      },
      { authenticate },
    );
  });
}
