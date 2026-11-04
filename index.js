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

const studioCategories = {
  "photo-studios": "Photo Studios",
  "sound-stages": "Sound Stages",
  "podcast-rooms": "Podcast Rooms",
  "music-suites": "Music Suites",
  "art-workshops": "Art Workshops",
};
const categorySlugs = new Set(Object.keys(studioCategories));
const studioInputFields = new Set([
  "title",
  "categorySlug",
  "hourlyRate",
  "securityDeposit",
  "capacity",
  "location",
  "image",
  "imageAlt",
  "amenities",
  "overview",
  "category",
  "slug",
  "_id",
  "ownerId",
  "ownerEmail",
  "ownerName",
  "host",
  "createdAt",
  "updatedAt",
  "rating",
  "reviewCount",
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
const emailSignupFields = new Set([
  "name",
  "email",
  "password",
  "image",
  "callbackURL",
  "rememberMe",
]);

export function validateSignUpInput(context) {
  if (context.path !== "/sign-up/email") return;

  const body = context.body ?? {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new APIError("BAD_REQUEST", {
      message: "Signup body must be an object.",
    });
  }

  if (Object.keys(body).some((field) => !emailSignupFields.has(field))) {
    throw new APIError("BAD_REQUEST", {
      message: "Signup contains unsupported fields.",
    });
  }

  const password = body.password;
  if (
    typeof password === "string" &&
    (!/[a-z]/.test(password) || !/[A-Z]/.test(password))
  ) {
    throw new APIError("BAD_REQUEST", {
      message: "Password must contain at least one lowercase and one uppercase letter.",
    });
  }

  let normalizedBody = body;
  if (Object.hasOwn(body, "image")) {
    if (typeof body.image !== "string") {
      throw new APIError("BAD_REQUEST", {
        message: "Image must be a valid HTTP(S) URL.",
      });
    }

    const image = body.image.trim();
    let parsedImage;
    try {
      parsedImage = new URL(image);
    } catch {
      throw new APIError("BAD_REQUEST", {
        message: "Image must be a valid HTTP(S) URL.",
      });
    }
    if (!["http:", "https:"].includes(parsedImage.protocol)) {
      throw new APIError("BAD_REQUEST", {
        message: "Image must be a valid HTTP(S) URL.",
      });
    }
    normalizedBody = { ...body, image };
  }

  return {
    context: {
      ...context,
      body: normalizedBody,
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

export function requireAuth(auth, { getDatabaseStatus } = {}) {
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
      if (getDatabaseStatus && getDatabaseStatus() !== "connected") {
        return response.status(503).json({
          success: false,
          message: "Database is not available",
          code: "DATABASE_NOT_READY",
          details: null,
        });
      }
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

function studioValidationError(message) {
  const error = new Error(message);
  error.code = "VALIDATION_ERROR";
  error.safeMessage = message;
  return error;
}

function requiredTrimmedString(value, name, minimumLength, maximumLength) {
  if (typeof value !== "string") {
    throw studioValidationError(`${name} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < minimumLength || trimmed.length > maximumLength) {
    throw studioValidationError(
      `${name} must be between ${minimumLength} and ${maximumLength} characters.`,
    );
  }
  return trimmed;
}

function parseStudioInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw studioValidationError("The request body must be a JSON object.");
  }

  const unexpectedField = Object.keys(body).find(
    (field) => !studioInputFields.has(field),
  );
  if (unexpectedField) {
    throw studioValidationError("The request includes an unsupported field.");
  }

  const title = requiredTrimmedString(body.title, "title", 3, 100);
  if (
    typeof body.categorySlug !== "string" ||
    !Object.hasOwn(studioCategories, body.categorySlug)
  ) {
    throw studioValidationError("categorySlug must be a supported studio category.");
  }
  if (
    typeof body.hourlyRate !== "number" ||
    !Number.isFinite(body.hourlyRate) ||
    body.hourlyRate <= 0
  ) {
    throw studioValidationError("hourlyRate must be a finite positive number.");
  }
  if (
    typeof body.securityDeposit !== "number" ||
    !Number.isFinite(body.securityDeposit) ||
    body.securityDeposit < 0
  ) {
    throw studioValidationError(
      "securityDeposit must be a finite non-negative number.",
    );
  }
  if (
    typeof body.capacity !== "number" ||
    !Number.isSafeInteger(body.capacity) ||
    body.capacity < 1
  ) {
    throw studioValidationError("capacity must be a positive integer.");
  }

  const location = requiredTrimmedString(body.location, "location", 2, 160);
  if (typeof body.image !== "string" || body.image.trim().length > 2048) {
    throw studioValidationError("image must be a valid HTTP(S) URL.");
  }
  const image = body.image.trim();
  let parsedImage;
  try {
    parsedImage = new URL(image);
  } catch {
    throw studioValidationError("image must be a valid HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(parsedImage.protocol)) {
    throw studioValidationError("image must be a valid HTTP(S) URL.");
  }

  let imageAlt = "";
  if (body.imageAlt !== undefined) {
    if (typeof body.imageAlt !== "string") {
      throw studioValidationError("imageAlt must be a string.");
    }
    imageAlt = body.imageAlt.trim();
    if (imageAlt.length > 250) {
      throw studioValidationError("imageAlt must be 250 characters or fewer.");
    }
  }

  if (
    !Array.isArray(body.amenities) ||
    body.amenities.length < 1 ||
    body.amenities.length > 20
  ) {
    throw studioValidationError("amenities must be an array of 1 to 20 strings.");
  }
  const amenities = [];
  const seenAmenities = new Set();
  for (const amenity of body.amenities) {
    if (typeof amenity !== "string") {
      throw studioValidationError("Each amenity must be a string.");
    }
    const trimmed = amenity.trim();
    if (!trimmed || trimmed.length > 80) {
      throw studioValidationError(
        "Each amenity must contain 1 to 80 non-whitespace characters.",
      );
    }
    const normalized = trimmed.toLocaleLowerCase("en-US");
    if (!seenAmenities.has(normalized)) {
      seenAmenities.add(normalized);
      amenities.push(trimmed);
    }
  }

  const overview = requiredTrimmedString(body.overview, "overview", 30, 2000);

  return {
    title,
    categorySlug: body.categorySlug,
    category: studioCategories[body.categorySlug],
    hourlyRate: body.hourlyRate,
    securityDeposit: body.securityDeposit,
    capacity: body.capacity,
    location,
    image,
    imageAlt,
    amenities,
    overview,
  };
}

function createStudioSlug(title, id) {
  const titleSlug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${titleSlug || "studio"}-${id.toHexString()}`;
}

export function registerStudioRoutes(
  app,
  {
    getDatabase: resolveDatabase,
    getDatabaseStatus = () => "connected",
    auth = null,
  },
) {
  app.post(
    "/api/studios",
    requireAuth(auth, { getDatabaseStatus }),
    async (request, response) => {
      const db = resolveDatabase();
      if (!db) {
        return response.status(503).json({
          success: false,
          message: "Database is not available",
          code: "DATABASE_NOT_READY",
          details: null,
        });
      }

      const user = request.user;
      const ownerEmail =
        typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
      const ownerName = typeof user.name === "string" ? user.name.trim() : "";
      if (
        typeof user.id !== "string" ||
        !user.id.trim() ||
        !ownerEmail ||
        !ownerName
      ) {
        return response.status(401).json({
          success: false,
          message: "Authenticated user must have an ID, email, and name",
          code: "AUTH_USER_INCOMPLETE",
          details: null,
        });
      }

      const input = parseStudioInput(request.body);
      const id = new ObjectId();
      const now = new Date();
      const host = {
        name: ownerName,
        ...(typeof user.image === "string" && user.image.trim()
          ? { avatar: user.image.trim() }
          : {}),
      };
      const studio = {
        _id: id,
        ...input,
        slug: createStudioSlug(input.title, id),
        ownerId: user.id,
        ownerEmail,
        ownerName,
        host,
        createdAt: now,
        updatedAt: now,
        reviewCount: 0,
      };

      await db.collection("studios").insertOne(studio);

      return response.status(201).json({
        success: true,
        message: "Studio created successfully",
        data: serializeStudio(studio),
      });
    },
  );

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
      registerStudioRoutes(expressApp, {
        getDatabase,
        getDatabaseStatus,
        auth,
      }),
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
