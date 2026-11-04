import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createApp } from "../src/app.js";
import { errorHandler } from "../src/middleware/error-handler.js";

const allowedOrigin = "https://client.example";
let databaseStatus = "disconnected";
let server;
let baseUrl;

before(async () => {
  const app = createApp({
    clientOrigins: [allowedOrigin],
    getDatabaseStatus: () => databaseStatus,
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("GET /api/health is live independently of MongoDB", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    message: "StudioSpace API is running",
    status: "ok",
  });
});

test("GET /api/ready returns 200 when MongoDB is connected", async () => {
  databaseStatus = "connected";
  const response = await fetch(`${baseUrl}/api/ready`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).database, "connected");
  databaseStatus = "disconnected";
});

test("GET /api/ready returns 503 when MongoDB is disconnected", async () => {
  const response = await fetch(`${baseUrl}/api/ready`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    success: false,
    message: "MongoDB is not connected",
    code: "DATABASE_NOT_READY",
    database: "disconnected",
    details: null,
  });
});

test("GET /api/ready returns 503 when MongoDB is not configured", async () => {
  databaseStatus = "not_configured";
  const response = await fetch(`${baseUrl}/api/ready`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).database, "not_configured");
  databaseStatus = "disconnected";
});

test("unknown routes use the standard JSON 404 shape", async () => {
  const response = await fetch(`${baseUrl}/api/not-a-route`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    success: false,
    message: "The requested API route was not found",
    code: "ROUTE_NOT_FOUND",
    details: null,
  });
});

test("the error handler does not expose stack traces or secret values", () => {
  const secret = "mongodb://private-user:private-password@private-host";
  const response = {
    statusCode: undefined,
    body: undefined,
    status(value) {
      this.statusCode = value;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
  const originalConsoleError = console.error;
  let loggedValue = "";
  console.error = (...values) => {
    loggedValue = values.map(String).join(" ");
  };

  try {
    errorHandler(
      new Error(secret),
      { method: "GET", path: "/api/test" },
      response,
      () => assert.fail("next should not be called before headers are sent"),
    );
  } finally {
    console.error = originalConsoleError;
  }

  const serializedResponse = JSON.stringify(response.body);
  assert.equal(response.statusCode, 500);
  assert.equal(serializedResponse.includes(secret), false);
  assert.equal(serializedResponse.includes("stack"), false);
  assert.equal(loggedValue.includes(secret), false);
});

test("the error handler delegates when response headers were sent", () => {
  let delegatedError;
  const error = new Error("already sent");
  errorHandler(
    error,
    { method: "GET", path: "/api/test" },
    { headersSent: true },
    (receivedError) => {
      delegatedError = receivedError;
    },
  );
  assert.equal(delegatedError, error);
});

test("allowed client origin receives credentialed CORS headers", async () => {
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: {
      Origin: allowedOrigin,
      "Access-Control-Request-Method": "GET",
    },
  });
  assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
});

test("unlisted origins receive no CORS allow-origin header", async () => {
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { Origin: "https://unlisted.example" },
  });
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("allowed CORS preflight requests are answered", async () => {
  const response = await fetch(`${baseUrl}/api/health`, {
    method: "OPTIONS",
    headers: {
      Origin: allowedOrigin,
      "Access-Control-Request-Method": "GET",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), allowedOrigin);
});
