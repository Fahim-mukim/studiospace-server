import { Router } from "express";

export function createHealthRouter({ getDatabaseStatus }) {
  const router = Router();

  router.get("/health", (_request, response) => {
    response.status(200).json({
      success: true,
      message: "StudioSpace API is running",
      status: "ok",
    });
  });

  router.get("/ready", (_request, response) => {
    const databaseStatus = getDatabaseStatus();
    if (databaseStatus === "connected") {
      return response.status(200).json({
        success: true,
        message: "StudioSpace API is ready",
        status: "ready",
        database: "connected",
      });
    }

    return response.status(503).json({
      success: false,
      message:
        databaseStatus === "not_configured"
          ? "MongoDB is not configured"
          : "MongoDB is not connected",
      code: "DATABASE_NOT_READY",
      database: databaseStatus,
      details: null,
    });
  });

  return router;
}
