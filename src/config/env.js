import dotenv from "dotenv";

dotenv.config();

const DEVELOPMENT_CLIENT_ORIGIN = "http://localhost:3000";

function hasHighEntropy(secret) {
  if (secret.length < 32) return false;

  const frequencies = new Map();
  for (const character of secret) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  if (frequencies.size < 16) return false;

  const entropy = [...frequencies.values()].reduce((total, count) => {
    const probability = count / secret.length;
    return total - probability * Math.log2(probability);
  }, 0);

  return entropy >= 4.3;
}

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

function parseBetterAuthUrl(value, nodeEnv) {
  if (!value) return "";

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BETTER_AUTH_URL must be a valid HTTP(S) server origin.");
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
    throw new Error("BETTER_AUTH_URL must be a valid HTTP(S) server origin.");
  }

  return url.origin;
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

  const betterAuthSecret = env.BETTER_AUTH_SECRET?.trim() || "";
  const betterAuthUrl = parseBetterAuthUrl(env.BETTER_AUTH_URL?.trim(), nodeEnv);
  if (betterAuthSecret && !hasHighEntropy(betterAuthSecret)) {
    throw new Error(
      "BETTER_AUTH_SECRET must be at least 32 characters and have high entropy.",
    );
  }
  if (Boolean(betterAuthSecret) !== Boolean(betterAuthUrl)) {
    throw new Error(
      "BETTER_AUTH_SECRET and BETTER_AUTH_URL must be configured together.",
    );
  }

  const googleClientId = env.GOOGLE_CLIENT_ID?.trim() || "";
  const googleClientSecret = env.GOOGLE_CLIENT_SECRET?.trim() || "";
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together.",
    );
  }

  return {
    port,
    clientOrigins: parseClientOrigins(env.CLIENT_URL, nodeEnv),
    mongodbUri,
    mongodbDbName,
    betterAuthSecret,
    betterAuthUrl,
    authEnabled: Boolean(betterAuthSecret && betterAuthUrl),
    googleClientId,
    googleClientSecret,
    googleOauthEnabled: Boolean(googleClientId && googleClientSecret),
    nodeEnv,
  };
}
