import { pathToFileURL } from "node:url";
import { createApp } from "./src/app.js";
import { loadConfig } from "./src/config/env.js";
import {
  closeDatabase,
  connectDatabase,
  getDatabaseStatus,
} from "./src/config/database.js";

export async function startServer() {
  const config = loadConfig();

  if (config.nodeEnv === "production" && !config.mongodbUri) {
    throw new Error(
      "MONGODB_URI is required in production; the server was not started.",
    );
  }

  if (config.mongodbUri) {
    try {
      await connectDatabase({
        uri: config.mongodbUri,
        databaseName: config.mongodbDbName,
      });
      console.info("MongoDB connection established and verified.");
    } catch {
      throw new Error(
        "MongoDB connection failed. Check MONGODB_URI, MONGODB_DB_NAME, network access, and credentials.",
      );
    }
  } else {
    console.warn(
      "MONGODB_URI is not configured; starting in development degraded mode. Readiness will return 503.",
    );
  }

  const app = createApp({
    clientOrigins: config.clientOrigins,
    getDatabaseStatus,
  });
  const server = await new Promise((resolve, reject) => {
    const httpServer = app.listen(config.port);
    const onError = (error) => reject(error);
    httpServer.once("error", onError);
    httpServer.once("listening", () => {
      httpServer.off("error", onError);
      resolve(httpServer);
    });
  });

  console.info(`StudioSpace API listening on port ${server.address().port}.`);

  let shutdownPromise;
  const shutdown = (signal) => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      console.info(`${signal} received; shutting down StudioSpace API.`);
      let shutdownFailed = false;

      try {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      } catch {
        shutdownFailed = true;
        console.error("HTTP server shutdown failed.");
      }

      try {
        await closeDatabase();
      } catch {
        shutdownFailed = true;
        console.error("MongoDB shutdown failed.");
      }

      if (shutdownFailed) process.exitCode = 1;
    })();

    return shutdownPromise;
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  return { app, server, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await startServer();
  } catch (error) {
    console.error(error.message);
    try {
      await closeDatabase();
    } catch {
      console.error("MongoDB shutdown after startup failure failed.");
    }
    process.exitCode = 1;
  }
}
