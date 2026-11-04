import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { verifyPassword } from "better-auth/crypto";
import { MongoClient } from "mongodb";
import { createApp } from "../src/app.js";
import { createBetterAuth, registerAuthHandler } from "../index.js";

const testMongoUri = process.env.MONGODB_TEST_URI?.trim();
const testDatabaseName = process.env.MONGODB_TEST_DB_NAME?.trim();
const hasTestDatabaseConfig = Boolean(testMongoUri || testDatabaseName);
const clientOrigin = "http://localhost:3000";
const skipReason =
  "Set MONGODB_TEST_URI and MONGODB_TEST_DB_NAME to run against a dedicated test database.";

function getSetCookies(response) {
  return response.headers.getSetCookie();
}

function getCookieHeader(setCookies) {
  return setCookies
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test(
  "BetterAuth persists signup, credential, and session records in MongoDB",
  { skip: hasTestDatabaseConfig ? false : skipReason, timeout: 60000 },
  async () => {
    assert.ok(testMongoUri, "MONGODB_TEST_URI must be explicitly configured.");
    assert.ok(
      testDatabaseName,
      "MONGODB_TEST_DB_NAME must be explicitly configured.",
    );
    assert.match(
      testDatabaseName,
      /(^|[_-])test($|[_-])/i,
      "MONGODB_TEST_DB_NAME must clearly identify a test database.",
    );
    assert.notEqual(
      testDatabaseName,
      process.env.MONGODB_DB_NAME?.trim() || "studiospace",
      "MONGODB_TEST_DB_NAME must differ from the application database name.",
    );

    const email = `studiospace-auth-${randomUUID()}@example.test`;
    const password = `AuthTest-${randomBytes(16).toString("base64url")}Z`;
    let mongoClient;
    let database;
    let server;

    try {
      try {
        mongoClient = new MongoClient(testMongoUri, {
          serverSelectionTimeoutMS: 5000,
        });
        await mongoClient.connect();
        database = mongoClient.db(testDatabaseName);
        await database.command({ ping: 1 });
      } catch {
        throw new Error(
          "Could not connect to the configured MongoDB test database.",
        );
      }

      const auth = createBetterAuth({
        database,
        mongoClient,
        config: {
          betterAuthSecret: randomBytes(32).toString("base64url"),
          betterAuthUrl: "http://localhost:5000",
          clientOrigins: [clientOrigin],
          googleOauthEnabled: false,
          nodeEnv: "development",
        },
      });
      const app = createApp({
        clientOrigins: [clientOrigin],
        registerAuthHandler: (expressApp) =>
          registerAuthHandler(expressApp, auth),
      });
      server = app.listen(0, "127.0.0.1");
      await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const baseUrl = `http://127.0.0.1:${server.address().port}/api/auth`;

      const preflightResponse = await fetch(`${baseUrl}/sign-up/email`, {
        method: "OPTIONS",
        headers: {
          origin: clientOrigin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      assert.equal(preflightResponse.status, 204);
      assert.equal(
        preflightResponse.headers.get("access-control-allow-origin"),
        clientOrigin,
      );
      assert.equal(
        preflightResponse.headers.get("access-control-allow-credentials"),
        "true",
      );

      async function request(path, { body, cookie } = {}) {
        const headers = { origin: clientOrigin };
        if (body !== undefined) headers["content-type"] = "application/json";
        if (cookie) headers.cookie = cookie;

        return fetch(`${baseUrl}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      }

      const signupResponse = await request("/sign-up/email", {
        body: {
          name: "Integration Creator",
          email,
          password,
          image: "https://images.example.test/profile.jpg",
        },
      });
      assert.equal(signupResponse.status, 200);
      assert.equal(
        signupResponse.headers.get("access-control-allow-origin"),
        clientOrigin,
      );
      assert.equal(
        signupResponse.headers.get("access-control-allow-credentials"),
        "true",
      );
      assert.equal(
        getSetCookies(signupResponse).length,
        0,
        "Signup with auto sign-in disabled must not set session cookies.",
      );

      const signupResult = await signupResponse.json();
      assert.ok(
        signupResult.token === null,
        "Signup with auto sign-in disabled must not create a session token.",
      );
      assert.equal(signupResult.user.email, email);

      const users = database.collection("user");
      const accounts = database.collection("account");
      const sessions = database.collection("session");
      const userDocuments = await users.find({ email }).toArray();
      assert.equal(userDocuments.length, 1);
      const userId = signupResult.user.id;
      assert.equal(userDocuments[0]._id.toString(), userId);

      const credentialAccounts = await accounts
        .find({ userId, providerId: "credential" })
        .toArray();
      assert.equal(credentialAccounts.length, 1);
      const storedPassword = credentialAccounts[0].password;
      assert.equal(typeof storedPassword, "string");
      assert.ok(
        storedPassword !== password,
        "The stored credential must not be the submitted plaintext password.",
      );
      assert.equal(
        await verifyPassword({ hash: storedPassword, password }),
        true,
      );
      assert.equal(await sessions.countDocuments({ userId }), 0);

      const unauthenticatedSessionResponse = await request("/get-session");
      assert.equal(unauthenticatedSessionResponse.status, 200);
      assert.equal(await unauthenticatedSessionResponse.json(), null);

      const duplicateResponse = await request("/sign-up/email", {
        body: {
          name: "Integration Creator",
          email,
          password: `OtherTest-${randomBytes(16).toString("base64url")}Z`,
        },
      });
      assert.equal(duplicateResponse.status, 200);
      assert.equal(
        duplicateResponse.headers.get("access-control-allow-origin"),
        clientOrigin,
      );
      assert.equal(
        getSetCookies(duplicateResponse).length,
        0,
        "Duplicate signup must not set a session cookie.",
      );
      const duplicateResult = await duplicateResponse.json();
      assert.deepEqual(
        Object.keys(duplicateResult).sort(),
        Object.keys(signupResult).sort(),
      );
      assert.ok(
        duplicateResult.token === null,
        "Duplicate signup should use the same no-session response shape.",
      );
      assert.notEqual(duplicateResult.user.id, userId);
      assert.ok(duplicateResult.user.id);
      assert.equal(await users.countDocuments({ email }), 1);
      assert.equal(
        await accounts.countDocuments({ userId, providerId: "credential" }),
        1,
      );
      assert.equal(await sessions.countDocuments({ userId }), 0);

      const incorrectLoginResponse = await request("/sign-in/email", {
        body: {
          email,
          password: `WrongTest-${randomBytes(16).toString("base64url")}Z`,
        },
      });
      assert.equal(incorrectLoginResponse.status, 401);
      assert.equal(
        getSetCookies(incorrectLoginResponse).length,
        0,
        "Incorrect credentials must not set session cookies.",
      );
      assert.equal(await sessions.countDocuments({ userId }), 0);

      const loginResponse = await request("/sign-in/email", {
        body: { email, password },
      });
      assert.equal(loginResponse.status, 200);
      assert.equal(
        loginResponse.headers.get("access-control-allow-origin"),
        clientOrigin,
      );
      assert.equal(
        loginResponse.headers.get("access-control-allow-credentials"),
        "true",
      );
      const loginResult = await loginResponse.json();
      assert.equal(loginResult.user.email, email);

      const sessionCookies = getSetCookies(loginResponse);
      assert.ok(sessionCookies.length > 0);
      assert.ok(
        sessionCookies.some((cookie) => /session/i.test(cookie)),
        "Login should set a BetterAuth session cookie.",
      );
      assert.ok(
        sessionCookies.every((cookie) => /;\s*httponly/i.test(cookie)),
        "BetterAuth session cookies must be HTTP-only.",
      );

      const persistedSessions = await sessions.find({ userId }).toArray();
      assert.equal(persistedSessions.length, 1);
      const cookieHeader = getCookieHeader(sessionCookies);

      const authenticatedSessionResponse = await request("/get-session", {
        cookie: cookieHeader,
      });
      assert.equal(authenticatedSessionResponse.status, 200);
      const authenticatedSession = await authenticatedSessionResponse.json();
      assert.equal(authenticatedSession.user.email, email);

      const logoutResponse = await request("/sign-out", {
        body: {},
        cookie: cookieHeader,
      });
      assert.equal(logoutResponse.status, 200);
      const clearedCookies = getSetCookies(logoutResponse);
      assert.ok(
        clearedCookies.some((cookie) => {
          if (!/session/i.test(cookie)) return false;
          if (/;\s*max-age=0(?:;|$)/i.test(cookie)) return true;
          const expires = cookie.match(/;\s*expires=([^;]+)/i)?.[1];
          return Boolean(expires && Date.parse(expires) <= Date.now());
        }),
        "Logout should expire the session cookie.",
      );
      assert.equal(await sessions.countDocuments({ userId }), 0);

      const postLogoutSessionResponse = await request("/get-session");
      assert.equal(postLogoutSessionResponse.status, 200);
      assert.equal(await postLogoutSessionResponse.json(), null);
    } finally {
      try {
        if (database) {
          const createdUser = await database
            .collection("user")
            .findOne({ email }, { projection: { _id: 1 } });
          if (createdUser) {
            const userId = createdUser._id.toString();
            await database.collection("session").deleteMany({ userId });
            await database.collection("account").deleteMany({ userId });
            await database
              .collection("user")
              .deleteOne({ _id: createdUser._id });
          }
        }
      } finally {
        try {
          if (server?.listening) await closeServer(server);
        } finally {
          if (mongoClient) await mongoClient.close();
        }
      }
    }
  },
);
