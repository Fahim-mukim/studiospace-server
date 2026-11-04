import { pathToFileURL } from "node:url";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { jwt } from "better-auth/plugins";
import { createApp } from "./src/app.js";
import { loadConfig } from "./src/config/env.js";
import {
  closeDatabase,
  connectDatabase,
  getDatabase,
  getMongoClient,
  getDatabaseStatus,
} from "./src/config/database.js";
import { ObjectId } from "mongodb";

const categorySlugs = new Set([
  "photo-studios",
  "sound-stages",
  "podcast-rooms",
  "music-suites",
  "art-workshops",
]);
const allowedSorts = new Set(["newest", "price-low", "price-high"]);
const publicStudioFields = [
  "title",
  "name",
  "slug",
  "category",
  "categorySlug",
  "hourlyRate",
  "securityDeposit",
  "capacity",
  "location",
  "city",
  "image",
  "imageAlt",
  "images",
  "amenities",
  "overview",
  "createdAt",
  "rating",
  "reviewCount",
];
const publicHostFields = ["name", "displayName", "avatar", "profileImage", "bio"];

export function validateSignUpInput(context) {
  if (context.path !== "/sign-up/email") return;

  const body = context.body ?? {};
  const password = body.password;
  if (
    typeof password === "string" &&
    (!/[a-z]/.test(password) || !/[A-Z]/.test(password))
  ) {
    throw new APIError("BAD_REQUEST", {
      message: "Password must contain at least one lowercase and one uppercase letter.",
    });
  }

  if (!Object.hasOwn(body, "photoURL")) return;
  if (typeof body.photoURL !== "string") {
    throw new APIError("BAD_REQUEST", {
      message: "Photo URL must be a valid HTTP(S) URL.",
    });
  }

  const photoURL = body.photoURL.trim();
  if (photoURL) {
    let parsedPhotoURL;
    try {
      parsedPhotoURL = new URL(photoURL);
    } catch {
      throw new APIError("BAD_REQUEST", {
        message: "Photo URL must be a valid HTTP(S) URL.",
      });
    }
    if (!["http:", "https:"].includes(parsedPhotoURL.protocol)) {
      throw new APIError("BAD_REQUEST", {
        message: "Photo URL must be a valid HTTP(S) URL.",
      });
    }
  }

  const signupBody = { ...body };
  delete signupBody.photoURL;
  return {
    context: {
      ...context,
      body: {
        ...signupBody,
        ...(photoURL ? { image: photoURL } : {}),
      },
    },
  };
}

export function buildBetterAuthOptions({ database, mongoClient, config }) {
  return {
    appName: "StudioSpace",
    baseURL: config.betterAuthUrl,
    secret: config.betterAuthSecret,
    trustedOrigins: config.clientOrigins,
    database: mongodbAdapter(database, {
      client: mongoClient,
      transaction: false,
    }),
    emailAndPassword: {
      enabled: true,
      autoSignIn: false,
      minPasswordLength: 6,
      maxPasswordLength: 128,
    },
    socialProviders: config.googleOauthEnabled
      ? {
          google: {
            clientId: config.googleClientId,
            clientSecret: config.googleClientSecret,
          },
        }
      : {},
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 60,
        strategy: "jwt",
      },
    },
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        ...(config.nodeEnv === "production" ? { secure: true } : {}),
      },
    },
    plugins: [jwt({ sessionCookieCache: true })],
    hooks: {
      before: createAuthMiddleware(validateSignUpInput),
    },
  };
}

export function createBetterAuth(dependencies) {
  return betterAuth(buildBetterAuthOptions(dependencies));
}

export function registerAuthHandler(app, auth) {
  const handler = auth
    ? toNodeHandler(auth)
    : (_request, response) =>
        response.status(503).json({
          success: false,
          message: "Authentication is not configured",
          code: "AUTH_NOT_CONFIGURED",
          details: null,
        });

  app.all("/api/auth", handler);
  app.all("/api/auth/*splat", handler);
}

export function requireAuth(auth) {
  return async (request, response, next) => {
    if (!auth) {
      return response.status(503).json({
        success: false,
        message: "Authentication is not configured",
        code: "AUTH_NOT_CONFIGURED",
        details: null,
      });
    }

    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
      });
      if (!session?.user) {
        return response.status(401).json({
          success: false,
          message: "Authentication is required",
          code: "UNAUTHENTICATED",
          details: null,
        });
      }

      request.authSession = session;
      request.user = session.user;
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function invalidQuery(message) {
  const error = new Error(message);
  error.code = "INVALID_QUERY";
  error.safeMessage = message;
  return error;
}

function queryString(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalidQuery(`${name} must be a single string value.`);
  }
  return value;
}

function parseNonNegativeNumber(value, name) {
  const input = queryString(value, name);
  if (input === undefined) return undefined;
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(input)) {
    throw invalidQuery(`${name} must be a non-negative number.`);
  }
  const number = Number(input);
  if (!Number.isFinite(number)) {
    throw invalidQuery(`${name} must be a non-negative number.`);
  }
  return number;
}

function parsePositiveInteger(value, name, fallback, maximum = Infinity) {
  const input = queryString(value, name);
  if (input === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(input)) {
    throw invalidQuery(`${name} must be a positive integer.`);
  }
  const number = Number(input);
  if (!Number.isSafeInteger(number) || number > maximum) {
    throw invalidQuery(`${name} must be between 1 and ${maximum}.`);
  }
  return number;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseStudioQuery(query) {
  const category = queryString(query.category, "category");
  if (category !== undefined && !categorySlugs.has(category)) {
    throw invalidQuery("category must be a supported studio category slug.");
  }

  const search = queryString(query.search, "search");
  if (search !== undefined && search.length > 100) {
    throw invalidQuery("search must be 100 characters or fewer.");
  }

  const minPrice = parseNonNegativeNumber(query.minPrice, "minPrice");
  const maxPrice = parseNonNegativeNumber(query.maxPrice, "maxPrice");
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    throw invalidQuery("minPrice cannot be greater than maxPrice.");
  }

  const limit = parsePositiveInteger(query.limit, "limit", 20, 100);
  const page = parsePositiveInteger(
    query.page,
    "page",
    1,
    Math.floor(Number.MAX_SAFE_INTEGER / limit),
  );
  const sort = queryString(query.sort, "sort") ?? "newest";
  if (!allowedSorts.has(sort)) {
    throw invalidQuery("sort must be newest, price-low, or price-high.");
  }

  const filter = {};
  if (category !== undefined) filter.categorySlug = category;
  if (minPrice !== undefined || maxPrice !== undefined) {
    filter.hourlyRate = {};
    if (minPrice !== undefined) filter.hourlyRate.$gte = minPrice;
    if (maxPrice !== undefined) filter.hourlyRate.$lte = maxPrice;
  }
  if (search?.trim()) {
    const expression = new RegExp(escapeRegex(search.trim()), "i");
    filter.$or = [
      { title: expression },
      { name: expression },
      { location: expression },
      { category: expression },
      { overview: expression },
      { amenities: expression },
    ];
  }

  const sortOrder =
    sort === "newest"
      ? { createdAt: -1, _id: -1 }
      : sort === "price-low"
        ? { hourlyRate: 1, _id: 1 }
        : { hourlyRate: -1, _id: 1 };

  return { filter, page, limit, sortOrder };
}

function serializeStudio(studio) {
  const serialized = { id: String(studio._id) };
  for (const field of publicStudioFields) {
    if (studio[field] !== undefined) serialized[field] = studio[field];
  }
  if (studio.host && typeof studio.host === "object") {
    serialized.host = Object.fromEntries(
      publicHostFields
        .filter((field) => studio.host[field] !== undefined)
        .map((field) => [field, studio.host[field]]),
    );
  }
  return serialized;
}

export function registerStudioRoutes(app, { getDatabase: resolveDatabase }) {
  app.get("/api/studios", async (request, response) => {
    const db = resolveDatabase();
    if (!db) {
      return response.status(503).json({
        success: false,
        message: "Database is not available",
        code: "DATABASE_NOT_READY",
        details: null,
      });
    }

    const { filter, page, limit, sortOrder } = parseStudioQuery(request.query);
    const collection = db.collection("studios");
    const [total, studios] = await Promise.all([
      collection.countDocuments(filter),
      collection
        .find(filter, {
          projection: Object.fromEntries([
            ["_id", 1],
            ...publicStudioFields.map((field) => [field, 1]),
            ["host.name", 1],
            ["host.displayName", 1],
            ["host.avatar", 1],
            ["host.profileImage", 1],
            ["host.bio", 1],
          ]),
        })
        .sort(sortOrder)
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
    ]);

    return response.status(200).json({
      success: true,
      message: "Studios retrieved successfully",
      data: studios.map(serializeStudio),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  });

  app.get("/api/studios/:id", async (request, response) => {
    const db = resolveDatabase();
    if (!db) {
      return response.status(503).json({
        success: false,
        message: "Database is not available",
        code: "DATABASE_NOT_READY",
        details: null,
      });
    }

    const { id } = request.params;
    const lookup = /^[\da-f]{24}$/i.test(id)
      ? { _id: new ObjectId(id) }
      : { slug: id };
    const studio = await db.collection("studios").findOne(lookup, {
      projection: Object.fromEntries([
        ["_id", 1],
        ...publicStudioFields.map((field) => [field, 1]),
        ["host.name", 1],
        ["host.displayName", 1],
        ["host.avatar", 1],
        ["host.profileImage", 1],
        ["host.bio", 1],
      ]),
    });

    if (!studio) {
      return response.status(404).json({
        success: false,
        message: "Studio not found",
        code: "STUDIO_NOT_FOUND",
        details: null,
      });
    }

    return response.status(200).json({
      success: true,
      message: "Studio retrieved successfully",
      data: serializeStudio(studio),
    });
  });
}

export async function startServer() {
  const config = loadConfig();

  if (config.nodeEnv === "production" && !config.authEnabled) {
    throw new Error(
      "BETTER_AUTH_SECRET and BETTER_AUTH_URL are required in production; the server was not started.",
    );
  }
  if (
    config.nodeEnv === "production" &&
    config.authEnabled &&
    config.clientOrigins.length === 0
  ) {
    throw new Error(
      "CLIENT_URL is required in production when authentication is enabled.",
    );
  }

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

  const auth = config.authEnabled && getDatabase()
    ? createBetterAuth({
        database: getDatabase(),
        mongoClient: getMongoClient(),
        config,
      })
    : null;

  if (!config.authEnabled) {
    console.warn(
      "BetterAuth is not configured; authentication endpoints will return 503.",
    );
  } else if (!auth) {
    console.warn(
      "BetterAuth is disabled because MongoDB is not connected; authentication endpoints will return 503.",
    );
  }

  const app = createApp({
    clientOrigins: config.clientOrigins,
    getDatabaseStatus,
    registerAuthHandler: (expressApp) =>
      registerAuthHandler(expressApp, auth),
    registerRoutes: (expressApp) =>
      registerStudioRoutes(expressApp, { getDatabase }),
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
