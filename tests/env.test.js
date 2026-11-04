import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../src/config/env.js";

test("development config includes its local client origin fallback", () => {
  const config = loadConfig({
    NODE_ENV: "development",
    PORT: "5000",
  });
  assert.deepEqual(config.clientOrigins, ["http://localhost:3000"]);
  assert.equal(config.mongodbUri, "");
  assert.equal(config.mongodbDbName, "studiospace");
});

test("production config allows only explicitly configured client origins", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    PORT: "5000",
    CLIENT_URL: "https://studio.example,https://admin.example",
    MONGODB_URI: "mongodb://example.invalid:27017",
    MONGODB_DB_NAME: "studiospace",
  });
  assert.deepEqual(config.clientOrigins, [
    "https://studio.example",
    "https://admin.example",
  ]);
});

test("invalid port and non-origin client URLs are rejected", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "development", PORT: "not-a-port" }),
    /PORT must be an integer/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        CLIENT_URL: "https://studio.example/path",
      }),
    /CLIENT_URL must contain valid HTTP\(S\) origins/,
  );
});

test("BetterAuth requires a high-entropy secret and server origin together", () => {
  const secret = randomBytes(32).toString("base64url");
  const config = loadConfig({
    NODE_ENV: "development",
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: "http://localhost:5000",
  });
  assert.equal(config.authEnabled, true);
  assert.equal(config.betterAuthUrl, "http://localhost:5000");

  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "development",
        BETTER_AUTH_SECRET: "not-a-secure-secret",
        BETTER_AUTH_URL: "http://localhost:5000",
      }),
    /BETTER_AUTH_SECRET must be at least 32 characters and have high entropy/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "development",
        BETTER_AUTH_SECRET: secret,
      }),
    /BETTER_AUTH_SECRET and BETTER_AUTH_URL must be configured together/,
  );
});

test("BetterAuth URL and Google OAuth credentials are validated", () => {
  const secret = randomBytes(32).toString("base64url");
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: secret,
        BETTER_AUTH_URL: "http://api.example.com",
      }),
    /BETTER_AUTH_URL must be a valid HTTP\(S\) server origin/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "development",
        GOOGLE_CLIENT_ID: "client-id",
      }),
    /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together/,
  );

  const config = loadConfig({
    NODE_ENV: "development",
    BETTER_AUTH_SECRET: secret,
    BETTER_AUTH_URL: "http://localhost:5000",
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
  });
  assert.equal(config.googleOauthEnabled, true);
});
