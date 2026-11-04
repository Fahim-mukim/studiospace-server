import cors from "cors";
import express from "express";
import { errorHandler } from "./middleware/error-handler.js";
import { notFound } from "./middleware/not-found.js";
import { createHealthRouter } from "./routes/health.routes.js";

export function createApp({
  clientOrigins = ["http://localhost:3000"],
  getDatabaseStatus = () => "not_configured",
  registerAuthHandler = () => {},
  registerRoutes = () => {},
} = {}) {
  const allowedOrigins = new Set(clientOrigins);
  const app = express();

  app.disable("x-powered-by");
  app.use(
    cors({
      origin(origin, callback) {
        callback(null, Boolean(origin && allowedOrigins.has(origin)));
      },
      credentials: true,
    }),
  );
  registerAuthHandler(app);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api", createHealthRouter({ getDatabaseStatus }));
  registerRoutes(app);
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
