import dotenv from "dotenv";

dotenv.config();

const DEVELOPMENT_CLIENT_ORIGIN = "http://localhost:3000";

function parseClientOrigins(value, nodeEnv) {
  const configuredOrigins = value
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : nodeEnv === "development"
      ? [DEVELOPMENT_CLIENT_ORIGIN]
      : [];
  const origins = new Set(configuredOrigins.map((item) => {
    let url;
    try {
      url = new URL(item);
    } catch {
      throw new Error("CLIENT_URL must contain valid HTTP(S) origins.");
    }

    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) {
      throw new Error("CLIENT_URL must contain valid HTTP(S) origins.");
    }
    return url.origin;
  }));

  if (nodeEnv === "development") {
    origins.add(DEVELOPMENT_CLIENT_ORIGIN);
  }

  return [...origins];
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const port = env.PORT === undefined || env.PORT === "" ? 5000 : Number(env.PORT);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }

  const mongodbUri = env.MONGODB_URI?.trim() || "";
  const mongodbDbName = env.MONGODB_DB_NAME?.trim() || "studiospace";

  if (mongodbUri && !env.MONGODB_DB_NAME?.trim()) {
    throw new Error("MONGODB_DB_NAME is required when MONGODB_URI is configured.");
  }

  return {
    port,
    clientOrigins: parseClientOrigins(env.CLIENT_URL, nodeEnv),
    mongodbUri,
    mongodbDbName,
    nodeEnv,
  };
}
