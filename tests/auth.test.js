import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { MongoClient } from "mongodb";
import { createApp } from "../src/app.js";
import {
  buildBetterAuthOptions,
  createBetterAuth,
  registerAuthHandler,
  requireAuth,
  validateSignUpInput,
} from "../index.js";

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("signup validates password case and maps Photo URL to the image field", () => {
  assert.throws(
    () =>
      validateSignUpInput({
        path: "/sign-up/email",
        body: { password: "lowercase" },
      }),
    /Password must contain at least one lowercase and one uppercase letter/,
  );
  assert.throws(
    () =>
      validateSignUpInput({
        path: "/sign-up/email",
        body: { password: "UPPERCASE" },
      }),
    /Password must contain at least one lowercase and one uppercase letter/,
  );

  const result = validateSignUpInput({
    path: "/sign-up/email",
    body: {
      name: "Creator",
      password: "CreatorPass1",
      photoURL: " https://images.example/creator.jpg ",
    },
  });
  assert.deepEqual(result.context.body, {
    name: "Creator",
    password: "CreatorPass1",
    image: "https://images.example/creator.jpg",
  });
});

test("signup rejects non-HTTP photo URLs and leaves other auth endpoints untouched", () => {
  assert.throws(
    () =>
      validateSignUpInput({
        path: "/sign-up/email",
        body: { password: "CreatorPass1", photoURL: "javascript:alert(1)" },
      }),
    /Photo URL must be a valid HTTP\(S\) URL/,
  );
  assert.equal(
    validateSignUpInput({
      path: "/sign-in/email",
      body: { password: "lowercase" },
    }),
    undefined,
  );
});

test("BetterAuth options enable email auth, JWT cookie caching, and optional Google OAuth", () => {
  const secret = randomBytes(32).toString("base64url");
  const config = {
    betterAuthSecret: secret,
    betterAuthUrl: "https://api.example.com",
    clientOrigins: ["https://client.example.com"],
    googleOauthEnabled: true,
    googleClientId: "google-client-id",
    googleClientSecret: "google-client-secret",
    nodeEnv: "production",
  };
  const options = buildBetterAuthOptions({
    database: {},
    mongoClient: {},
    config,
  });

  assert.equal(options.emailAndPassword.enabled, true);
  assert.equal(options.emailAndPassword.autoSignIn, false);
  assert.equal(options.emailAndPassword.minPasswordLength, 6);
  assert.deepEqual(options.session.cookieCache, {
    enabled: true,
    maxAge: 60,
    strategy: "jwt",
  });
  assert.deepEqual(options.advanced.defaultCookieAttributes, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
  });
  assert.deepEqual(options.trustedOrigins, config.clientOrigins);
  assert.deepEqual(options.socialProviders.google, {
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
  });
  assert.equal(options.plugins.length, 1);
  assert.equal(options.plugins[0].id, "jwt");
  assert.equal(options.plugins[0].options.sessionCookieCache, true);

  const withoutGoogle = buildBetterAuthOptions({
    database: {},
    mongoClient: {},
    config: { ...config, googleOauthEnabled: false },
  });
  assert.deepEqual(withoutGoogle.socialProviders, {});
});

test("the configured BetterAuth handler responds without a database write", async () => {
  const mongoClient = new MongoClient("mongodb://127.0.0.1:27017");
  const auth = createBetterAuth({
    database: mongoClient.db("auth-smoke-test"),
    mongoClient,
    config: {
      betterAuthSecret: randomBytes(32).toString("base64url"),
      betterAuthUrl: "http://localhost:5000",
      clientOrigins: ["http://localhost:3000"],
      googleOauthEnabled: false,
      nodeEnv: "development",
    },
  });
  const app = createApp({
    registerAuthHandler: (expressApp) =>
      registerAuthHandler(expressApp, auth),
  });

  try {
    await withServer(app, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/auth/ok`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    });
  } finally {
    await mongoClient.close();
  }
});

test("unconfigured auth endpoints return 503 and mount before JSON parsing", async () => {
  const app = createApp({
    registerAuthHandler: (expressApp) => {
      registerAuthHandler(expressApp, null);
      expressApp.post("/api/parser-order/*splat", (request, response) => {
        response.json({ parsed: request.body !== undefined });
      });
    },
  });

  await withServer(app, async (baseUrl) => {
    const authResponse = await fetch(`${baseUrl}/api/auth/ok`);
    assert.equal(authResponse.status, 503);
    assert.equal((await authResponse.json()).code, "AUTH_NOT_CONFIGURED");

    const orderResponse = await fetch(`${baseUrl}/api/parser-order/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test: true }),
    });
    assert.deepEqual(await orderResponse.json(), { parsed: false });
  });
});

test("requireAuth rejects missing sessions and accepts a BetterAuth session", async () => {
  const session = {
    session: { id: "session-id" },
    user: { id: "user-id", name: "Creator" },
  };
  const auth = {
    api: {
      async getSession({ headers }) {
        return headers.get("cookie") === "session=valid" ? session : null;
      },
    },
  };
  const app = createApp({
    registerRoutes(expressApp) {
      expressApp.get("/api/private", requireAuth(auth), (request, response) => {
        response.json({
          user: request.user,
          session: request.authSession.session,
        });
      });
    },
  });

  await withServer(app, async (baseUrl) => {
    const unauthenticated = await fetch(`${baseUrl}/api/private`);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).code, "UNAUTHENTICATED");

    const authenticated = await fetch(`${baseUrl}/api/private`, {
      headers: { cookie: "session=valid" },
    });
    assert.equal(authenticated.status, 200);
    assert.deepEqual(await authenticated.json(), {
      user: session.user,
      session: session.session,
    });
  });
});

test("requireAuth returns 503 when disabled and forwards session errors", async () => {
  const app = createApp({
    registerRoutes(expressApp) {
      expressApp.get("/api/disabled", requireAuth(null), (_request, response) => {
        response.json({ success: true });
      });
      expressApp.get(
        "/api/session-error",
        requireAuth({
          api: {
            async getSession() {
              throw new Error("session backend unavailable");
            },
          },
        }),
        (_request, response) => response.json({ success: true }),
      );
    },
  });

  await withServer(app, async (baseUrl) => {
    const disabled = await fetch(`${baseUrl}/api/disabled`);
    assert.equal(disabled.status, 503);
    assert.equal((await disabled.json()).code, "AUTH_NOT_CONFIGURED");

    const failed = await fetch(`${baseUrl}/api/session-error`);
    assert.equal(failed.status, 500);
    assert.equal((await failed.json()).code, "INTERNAL_SERVER_ERROR");
  });
});
