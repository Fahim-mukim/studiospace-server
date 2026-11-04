import assert from "node:assert/strict";
import test from "node:test";
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
