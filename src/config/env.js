import dotenv from "dotenv";

dotenv.config();

const DEFAULT_DEVELOPMENT_CLIENT_ORIGIN = "http://localhost:3000";

function parseClientOrigins(value, nodeEnv, developmentClientOrigin) {
  const configuredOrigins = value
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : nodeEnv === "development"
      ? [developmentClientOrigin]
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
    origins.add(DEFAULT_DEVELOPMENT_CLIENT_ORIGIN);
    origins.add(developmentClientOrigin);
  }
  if (nodeEnv === "production" && origins.size === 0) {
    throw new Error("CLIENT_URL is required in production.");
  }

  return [...origins];
}

function parseClientAuthUrl(value, nodeEnv, developmentClientOrigin) {
  const configuredOrigin =
    value || (nodeEnv === "development" ? developmentClientOrigin : "");
  if (!configuredOrigin) {
    throw new Error("CLIENT_AUTH_URL is required outside development.");
  }

  let url;
  try {
    url = new URL(configuredOrigin);
  } catch {
    throw new Error("CLIENT_AUTH_URL must be a valid HTTP(S) origin.");
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash ||
    (nodeEnv === "production" && url.protocol !== "https:")
  ) {
    throw new Error("CLIENT_AUTH_URL must be a valid HTTP(S) origin.");
  }

  return url.origin;
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || "development";
  const developmentClientOrigin =
    env.CLIENT_URL?.split(",")[0]?.trim() || DEFAULT_DEVELOPMENT_CLIENT_ORIGIN;
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
    clientOrigins: parseClientOrigins(env.CLIENT_URL, nodeEnv, developmentClientOrigin),
    clientAuthUrl: parseClientAuthUrl(
      env.CLIENT_AUTH_URL?.trim(),
      nodeEnv,
      developmentClientOrigin,
    ),
    mongodbUri,
    mongodbDbName,
    nodeEnv,
  };
}
