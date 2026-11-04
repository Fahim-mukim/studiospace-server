import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config/env.js";

test("development config defaults Client CORS and authentication to localhost", () => {
  const config = loadConfig({
    NODE_ENV: "development",
    PORT: "5000",
  });
  assert.deepEqual(config.clientOrigins, ["http://localhost:3000"]);
  assert.equal(config.clientAuthUrl, "http://localhost:3000");
  assert.equal(config.mongodbUri, "");
  assert.equal(config.mongodbDbName, "studiospace");
});

test("production config requires explicit Client and database settings", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    PORT: "5000",
    CLIENT_URL: "https://studio.example,https://admin.example",
    CLIENT_AUTH_URL: "https://studio.example",
    MONGODB_URI: "mongodb://example.invalid:27017",
    MONGODB_DB_NAME: "studiospace",
  });
  assert.deepEqual(config.clientOrigins, [
    "https://studio.example",
    "https://admin.example",
  ]);
  assert.equal(config.clientAuthUrl, "https://studio.example");

  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        CLIENT_URL: "https://studio.example",
      }),
    /CLIENT_AUTH_URL is required outside development/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        CLIENT_AUTH_URL: "https://studio.example",
      }),
    /CLIENT_URL is required in production/,
  );
});

test("invalid port and non-origin URLs are rejected", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "development", PORT: "not-a-port" }),
    /PORT must be an integer/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        CLIENT_URL: "https://studio.example/path",
        CLIENT_AUTH_URL: "https://studio.example",
      }),
    /CLIENT_URL must contain valid HTTP\(S\) origins/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        CLIENT_URL: "https://studio.example",
        CLIENT_AUTH_URL: "http://studio.example",
      }),
    /CLIENT_AUTH_URL must be a valid HTTP\(S\) origin/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "development",
        CLIENT_AUTH_URL: "http://localhost:3000/api/auth",
      }),
    /CLIENT_AUTH_URL must be a valid HTTP\(S\) origin/,
  );
});

test("MongoDB database name is required when a URI is configured", () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "development",
        MONGODB_URI: "mongodb://example.invalid:27017",
      }),
    /MONGODB_DB_NAME is required/,
  );
});
