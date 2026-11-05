import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { createApp } from "../src/app.js";
import {
  createRequireAuth,
  getRemoteJwksResolver,
  JwksUnavailableError,
  readSessionDataCookie,
} from "../src/middleware/require-auth.js";
import { registerStudioRoutes } from "../index.js";

const issuer = "http://localhost:3000";
const audience = "better-auth:session-cache";
const jwtType = "better-auth.session-cache+jwt";
const user = {
  id: "client-user-123",
  name: "Verified Creator",
  email: "creator@example.test",
  image: "https://images.example.test/creator.jpg",
};
const { privateKey, publicKey } = await generateKeyPair("EdDSA");
const publicJwk = {
  ...(await exportJWK(publicKey)),
  alg: "EdDSA",
  kid: "auth-test-key",
  use: "sig",
};
const jwksResolver = createLocalJWKSet({ keys: [publicJwk] });
const authenticate = createRequireAuth({ issuer, jwksResolver });
const servers = [];

async function createToken({
  tokenUser = user,
  tokenIssuer = issuer,
  tokenAudience = audience,
  tokenType = jwtType,
  expiresAt = Math.floor(Date.now() / 1000) + 60,
  notBefore,
  session = {},
  payload = {},
  key = privateKey,
  keyId = publicJwk.kid,
} = {}) {
  const sessionToken = "session-token-123";
  const claims = {
    sid: sessionToken,
    session: {
      id: "session-id-123",
      token: sessionToken,
      userId: tokenUser?.id ?? user.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      ...session,
    },
    user: tokenUser,
    updatedAt: Date.now(),
    ...payload,
  };
  let token = new SignJWT(claims)
    .setProtectedHeader({
      alg: "EdDSA",
      kid: keyId,
      typ: tokenType,
    })
    .setIssuer(tokenIssuer)
    .setAudience(tokenAudience)
    .setSubject(payload.sub ?? tokenUser?.id ?? user.id)
    .setIssuedAt();
  if (expiresAt !== null) token = token.setExpirationTime(expiresAt);
  if (notBefore !== undefined) token = token.setNotBefore(notBefore);
  return token.sign(key);
}

function createServer({
  middleware = authenticate,
  database = createMockDatabase(),
} = {}) {
  const app = createApp({
    clientOrigins: [issuer],
    registerRoutes(expressApp) {
      expressApp.get("/api/private", middleware, (request, response) => {
        response.json({ user: request.user });
      });
      registerStudioRoutes(expressApp, {
        getDatabase: () => database,
        authenticate: middleware,
      });
    },
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("listening", () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
      });
    });
    server.once("error", reject);
  });
}

function createMockDatabase() {
  const inserted = [];
  return {
    inserted,
    collection(name) {
      assert.equal(name, "studios");
      return {
        async insertOne(document) {
          inserted.push(document);
          return { acknowledged: true };
        },
      };
    },
  };
}

async function request(baseUrl, token, path = "/api/private") {
  return fetch(`${baseUrl}${path}`, {
    ...(path === "/api/studios" ? { method: "POST" } : {}),
    headers: token ? { cookie: `better-auth.session_data=${token}` } : {},
    ...(path === "/api/studios"
      ? {
          headers: {
            "content-type": "application/json",
            ...(token
              ? { cookie: `better-auth.session_data=${token}` }
              : {}),
          },
          body: JSON.stringify({
            ownerId: "client-controlled-id",
            ownerEmail: "attacker@example.test",
            ownerName: "Attacker",
          }),
        }
      : {}),
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

test("the resolver is cached by the configured JWKS URL", () => {
  const endpoint = `${issuer}/api/auth/jwks`;
  assert.equal(getRemoteJwksResolver(endpoint), getRemoteJwksResolver(endpoint));
});

test("session_data cookie parsing supports local, secure, and chunked cookies", async () => {
  const token = await createToken();
  assert.equal(
    readSessionDataCookie(`better-auth.session_data=${token}`),
    token,
  );
  assert.equal(
    readSessionDataCookie(`__Secure-better-auth.session_data=${token}`),
    token,
  );
  assert.equal(
    readSessionDataCookie(`better-auth-session_data=${token}`),
    token,
  );
  assert.equal(
    readSessionDataCookie(`better-auth.session_token=${token}`),
    null,
    "The opaque session_token cookie must never be treated as a JWT.",
  );

  const firstChunk = token.slice(0, 40);
  const secondChunk = token.slice(40);
  assert.equal(
    readSessionDataCookie(
      `__Secure-better-auth.session_data.1=${secondChunk}; __Secure-better-auth.session_data.0=${firstChunk}`,
    ),
    token,
  );
  assert.equal(
    readSessionDataCookie(
      `better-auth.session_data.1=${secondChunk}`,
    ),
    null,
    "Chunk indexes must be contiguous and start at zero.",
  );
  assert.equal(
    readSessionDataCookie(
      `better-auth.session_data=${token}; better-auth.session_data.0=${firstChunk}`,
    ),
    null,
    "A root cookie and chunked cookies are ambiguous.",
  );
  assert.equal(
    readSessionDataCookie(
      `better-auth.session_data=${token}; __Secure-better-auth.session_data=${token}`,
    ),
    null,
    "Secure and non-secure copies are ambiguous.",
  );
});

test("a missing JWT-backed session cookie returns the standard 401 response", async () => {
  const { baseUrl } = await createServer();
  const response = await request(baseUrl, null);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    success: false,
    message: "Authentication is required",
    code: "UNAUTHENTICATED",
    details: null,
  });
});

test("a valid Client session-cache JWT attaches only verified user identity", async () => {
  const { baseUrl } = await createServer();
  const token = await createToken();
  const response = await request(baseUrl, token);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user });
});

test("malformed and tampered JWTs are rejected", async (t) => {
  const { baseUrl } = await createServer();
  await t.test("malformed", async () => {
    const response = await request(baseUrl, "not.a.jwt");
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "UNAUTHENTICATED");
  });
  await t.test("tampered signature", async () => {
    const token = await createToken();
    const [header, claims, signature] = token.split(".");
    const replacement = signature[0] === "a" ? "b" : "a";
    const response = await request(
      baseUrl,
      `${header}.${claims}.${replacement}${signature.slice(1)}`,
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, "UNAUTHENTICATED");
  });
});

test("expired and not-yet-valid JWTs are rejected", async (t) => {
  const { baseUrl } = await createServer();
  await t.test("expired", async () => {
    const token = await createToken({
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });
    const response = await request(baseUrl, token);
    assert.equal(response.status, 401);
  });
  await t.test("not yet valid", async () => {
    const token = await createToken({
      notBefore: Math.floor(Date.now() / 1000) + 60,
    });
    const response = await request(baseUrl, token);
    assert.equal(response.status, 401);
  });
});

test("wrong issuer, audience, type, or key are rejected", async (t) => {
  const { baseUrl } = await createServer();
  const alternatePair = await generateKeyPair("EdDSA");
  const cases = [
    ["wrong issuer", { tokenIssuer: "https://another-client.example" }],
    ["wrong audience", { tokenAudience: "another-audience" }],
    ["wrong Better Auth type", { tokenType: "JWT" }],
    ["unknown signing key", { keyId: "unknown-key" }],
    ["wrong signing key", { key: alternatePair.privateKey }],
  ];

  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const token = await createToken(options);
      const response = await request(baseUrl, token);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, "UNAUTHENTICATED");
    });
  }
});

test("missing and mismatched Better Auth identity fields are rejected", async (t) => {
  const { baseUrl } = await createServer();
  const cases = [
    ["missing user", { tokenUser: null }],
    ["missing name", { tokenUser: { ...user, name: "" } }],
    ["missing email", { tokenUser: { ...user, email: "" } }],
    ["malformed email", { tokenUser: { ...user, email: "not-an-email" } }],
    [
      "JWT subject differs from user ID",
      { payload: { sub: "different-user-id" } },
    ],
    [
      "session owner differs from user ID",
      { session: { userId: "different-user-id" } },
    ],
    [
      "session token differs from sid",
      { session: { token: "different-session-token" } },
    ],
    [
      "expired persisted session",
      { session: { expiresAt: new Date(Date.now() - 1000).toISOString() } },
    ],
    [
      "invalid profile image",
      { tokenUser: { ...user, image: "javascript:alert(1)" } },
    ],
  ];

  for (const [name, options] of cases) {
    await t.test(name, async () => {
      const token = await createToken(options);
      const response = await request(baseUrl, token);
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, "UNAUTHENTICATED");
    });
  }
});

test("JWKS service failures return a safe 503, not an authenticated user", async () => {
  const middleware = createRequireAuth({
    issuer,
    jwksResolver: async () => {
      throw new JwksUnavailableError();
    },
  });
  const { baseUrl } = await createServer({ middleware });
  const response = await request(baseUrl, await createToken());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    success: false,
    message: "Authentication verification is unavailable",
    code: "AUTHENTICATION_UNAVAILABLE",
    details: null,
  });
});

test("POST /api/studios requires verified identity and ignores client ownership fields", async () => {
  const database = createMockDatabase();
  const { baseUrl } = await createServer({ database });
  const unauthenticated = await request(
    baseUrl,
    null,
    "/api/studios",
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).code, "UNAUTHENTICATED");

  const payload = {
    title: "Daylight Photo Studio",
    categorySlug: "photo-studios",
    hourlyRate: 95,
    securityDeposit: 150,
    capacity: 8,
    location: "Brooklyn, New York",
    image: "https://images.example.test/daylight.jpg",
    amenities: ["Natural light"],
    overview:
      "A bright studio suitable for portrait sessions and small productions.",
    ownerId: "client-controlled-id",
    ownerEmail: "attacker@example.test",
    ownerName: "Attacker",
    host: { name: "Attacker", avatar: "javascript:alert(1)" },
  };
  const token = await createToken();
  const authenticated = await fetch(`${baseUrl}/api/studios`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `better-auth.session_data=${token}`,
    },
    body: JSON.stringify(payload),
  });
  assert.equal(authenticated.status, 201);
  assert.equal(database.inserted.length, 1);
  assert.equal(database.inserted[0].ownerId, user.id);
  assert.equal(database.inserted[0].ownerEmail, user.email);
  assert.equal(database.inserted[0].ownerName, user.name);
  assert.deepEqual(database.inserted[0].host, {
    name: user.name,
    avatar: user.image,
  });
});
