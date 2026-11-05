import { pathToFileURL } from "node:url";
import { createApp } from "./src/app.js";
import { loadConfig } from "./src/config/env.js";
import {
  closeDatabase,
  connectDatabase,
  getDatabase,
  getDatabaseStatus,
} from "./src/config/database.js";
import { ObjectId } from "mongodb";
import {
  createRequireAuth,
  getRemoteJwksResolver,
} from "./src/middleware/require-auth.js";
import { ensureCollectionIndexes } from "./src/config/indexes.js";

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
function rejectUnauthenticated(_request, response) {
  return response.status(401).json({
    success: false,
    message: "Authentication is required",
    code: "UNAUTHENTICATED",
    details: null,
  });
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
    authenticate = rejectUnauthenticated,
  },
) {
  app.post(
    "/api/studios",
    authenticate,
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
      if (!user || typeof user !== "object") {
        return response.status(401).json({
          success: false,
          message: "Authenticated user must have an ID, email, and name",
          code: "AUTH_USER_INCOMPLETE",
          details: null,
        });
      }
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

  app.get("/api/studios/mine", authenticate, async (request, response) => {
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
    if (!user || typeof user !== "object") {
      return response.status(401).json({
        success: false,
        message: "Authentication is required",
        code: "UNAUTHENTICATED",
        details: null,
      });
    }
    const ownerId = typeof user.id === "string" ? user.id.trim() : "";
    if (!ownerId) {
      return response.status(401).json({
        success: false,
        message: "Authenticated user must have an ID, email, and name",
        code: "AUTH_USER_INCOMPLETE",
        details: null,
      });
    }

    const collection = db.collection("studios");
    const studios = await collection
      .find(
        { ownerId },
        {
          projection: Object.fromEntries([
            ["_id", 1],
            ...publicStudioFields.map((field) => [field, 1]),
            ["host.name", 1],
            ["host.displayName", 1],
            ["host.avatar", 1],
            ["host.profileImage", 1],
            ["host.bio", 1],
            ["ownerId", 1],
          ]),
        },
      )
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    return response.status(200).json({
      success: true,
      message: "Your studios retrieved successfully",
      data: studios.map(serializeStudio),
    });
  });

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

  app.patch(
    "/api/studios/:id",
    authenticate,
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
      if (!user || typeof user !== "object") {
        return response.status(401).json({
          success: false,
          message: "Authentication is required",
          code: "UNAUTHENTICATED",
          details: null,
        });
      }
      const ownerId = typeof user.id === "string" ? user.id.trim() : "";
      if (!ownerId) {
        return response.status(401).json({
          success: false,
          message: "Authenticated user must have an ID, email, and name",
          code: "AUTH_USER_INCOMPLETE",
          details: null,
        });
      }

      const { id } = request.params;
      const lookup = /^[\da-f]{24}$/i.test(id)
        ? { _id: new ObjectId(id) }
        : { slug: id };
      const existing = await db.collection("studios").findOne(lookup);
      if (!existing) {
        return response.status(404).json({
          success: false,
          message: "Studio not found",
          code: "STUDIO_NOT_FOUND",
          details: null,
        });
      }
      if (existing.ownerId !== ownerId) {
        return response.status(403).json({
          success: false,
          message: "You do not have permission to update this studio",
          code: "FORBIDDEN",
          details: null,
        });
      }

      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
        throw studioValidationError("The request body must be a JSON object.");
      }

      const unexpectedField = Object.keys(request.body).find(
        (field) => !studioInputFields.has(field),
      );
      if (unexpectedField) {
        throw studioValidationError("The request includes an unsupported field.");
      }

      const updates = {};
      const now = new Date();

      if (Object.hasOwn(request.body, "title")) {
        updates.title = requiredTrimmedString(request.body.title, "title", 3, 100);
      }
      if (Object.hasOwn(request.body, "categorySlug")) {
        if (
          typeof request.body.categorySlug !== "string" ||
          !Object.hasOwn(studioCategories, request.body.categorySlug)
        ) {
          throw studioValidationError("categorySlug must be a supported studio category.");
        }
        updates.categorySlug = request.body.categorySlug;
        updates.category = studioCategories[request.body.categorySlug];
      }
      if (Object.hasOwn(request.body, "hourlyRate")) {
        if (
          typeof request.body.hourlyRate !== "number" ||
          !Number.isFinite(request.body.hourlyRate) ||
          request.body.hourlyRate <= 0
        ) {
          throw studioValidationError("hourlyRate must be a finite positive number.");
        }
        updates.hourlyRate = request.body.hourlyRate;
      }
      if (Object.hasOwn(request.body, "securityDeposit")) {
        if (
          typeof request.body.securityDeposit !== "number" ||
          !Number.isFinite(request.body.securityDeposit) ||
          request.body.securityDeposit < 0
        ) {
          throw studioValidationError(
            "securityDeposit must be a finite non-negative number.",
          );
        }
        updates.securityDeposit = request.body.securityDeposit;
      }
      if (Object.hasOwn(request.body, "capacity")) {
        if (
          typeof request.body.capacity !== "number" ||
          !Number.isSafeInteger(request.body.capacity) ||
          request.body.capacity < 1
        ) {
          throw studioValidationError("capacity must be a positive integer.");
        }
        updates.capacity = request.body.capacity;
      }
      if (Object.hasOwn(request.body, "location")) {
        updates.location = requiredTrimmedString(request.body.location, "location", 2, 160);
      }
      if (Object.hasOwn(request.body, "image")) {
        if (typeof request.body.image !== "string" || request.body.image.trim().length > 2048) {
          throw studioValidationError("image must be a valid HTTP(S) URL.");
        }
        const image = request.body.image.trim();
        let parsedImage;
        try {
          parsedImage = new URL(image);
        } catch {
          throw studioValidationError("image must be a valid HTTP(S) URL.");
        }
        if (!["http:", "https:"].includes(parsedImage.protocol)) {
          throw studioValidationError("image must be a valid HTTP(S) URL.");
        }
        updates.image = image;
      }
      if (Object.hasOwn(request.body, "imageAlt")) {
        if (request.body.imageAlt === null || request.body.imageAlt === "") {
          updates.imageAlt = "";
        } else if (typeof request.body.imageAlt !== "string") {
          throw studioValidationError("imageAlt must be a string.");
        } else {
          const imageAlt = request.body.imageAlt.trim();
          if (imageAlt.length > 250) {
            throw studioValidationError("imageAlt must be 250 characters or fewer.");
          }
          updates.imageAlt = imageAlt;
        }
      }
      if (Object.hasOwn(request.body, "amenities")) {
        if (
          !Array.isArray(request.body.amenities) ||
          request.body.amenities.length < 1 ||
          request.body.amenities.length > 20
        ) {
          throw studioValidationError("amenities must be an array of 1 to 20 strings.");
        }
        const amenities = [];
        const seenAmenities = new Set();
        for (const amenity of request.body.amenities) {
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
        updates.amenities = amenities;
      }
      if (Object.hasOwn(request.body, "overview")) {
        updates.overview = requiredTrimmedString(request.body.overview, "overview", 30, 2000);
      }

      if (Object.keys(updates).length === 0) {
        throw studioValidationError("At least one editable field must be provided.");
      }

      updates.updatedAt = now;

      await db.collection("studios").updateOne({ _id: existing._id }, { $set: updates });

      const updated = await db.collection("studios").findOne({ _id: existing._id });
      return response.status(200).json({
        success: true,
        message: "Studio updated successfully",
        data: serializeStudio(updated),
      });
    },
  );

  app.delete("/api/studios/:id", authenticate, async (request, response) => {
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
    const ownerId = typeof user?.id === "string" ? user.id.trim() : "";
    if (!ownerId) {
      return response.status(401).json({
        success: false,
        message: "Authentication is required",
        code: "UNAUTHENTICATED",
        details: null,
      });
    }

    const { id } = request.params;
    if (typeof id !== "string" || !id || id.length > 200) {
      return response.status(404).json({
        success: false,
        message: "Studio not found",
        code: "STUDIO_NOT_FOUND",
        details: null,
      });
    }
    const lookup = /^[\da-f]{24}$/i.test(id)
      ? { _id: new ObjectId(id) }
      : { slug: id };
    const studios = db.collection("studios");
    const existing = await studios.findOne(lookup);
    if (!existing) {
      return response.status(404).json({
        success: false,
        message: "Studio not found",
        code: "STUDIO_NOT_FOUND",
        details: null,
      });
    }
    if (existing.ownerId !== ownerId) {
      return response.status(403).json({
        success: false,
        message: "You do not have permission to delete this studio",
        code: "FORBIDDEN",
        details: null,
      });
    }

    const booking = await db
      .collection("bookings")
      .findOne({ studioId: String(existing._id) });
    if (booking) {
      return response.status(409).json({
        success: false,
        message: "This studio cannot be deleted because it has booking history",
        code: "STUDIO_HAS_BOOKINGS",
        details: null,
      });
    }

    const result = await studios.deleteOne({
      _id: existing._id,
      ownerId,
    });
    if (result.deletedCount !== 1) {
      return response.status(404).json({
        success: false,
        message: "Studio not found",
        code: "STUDIO_NOT_FOUND",
        details: null,
      });
    }

    return response.status(200).json({
      success: true,
      message: "Studio deleted successfully",
      data: { id: String(existing._id) },
    });
  });

  app.post("/api/bookings", authenticate, async (request, response) => {
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
    if (!user || typeof user !== "object") {
      return response.status(401).json({
        success: false,
        message: "Authentication is required",
        code: "UNAUTHENTICATED",
        details: null,
      });
    }
    const userId = typeof user.id === "string" ? user.id.trim() : "";
    const userEmail = typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
    const userName = typeof user.name === "string" ? user.name.trim() : "";
    if (!userId || !userEmail || !userName) {
      return response.status(401).json({
        success: false,
        message: "Authenticated user must have an ID, email, and name",
        code: "AUTH_USER_INCOMPLETE",
        details: null,
      });
    }

    const body = request.body || {};
    const { studioId, bookingDate, startTime, endTime } = body;

    if (!studioId || typeof studioId !== "string") {
      throw studioValidationError("studioId is required.");
    }

    const lookup = /^[\da-f]{24}$/i.test(studioId)
      ? { _id: new ObjectId(studioId) }
      : { slug: studioId };
    const studio = await db.collection("studios").findOne(lookup);
    if (!studio) {
      return response.status(404).json({
        success: false,
        message: "Studio not found",
        code: "STUDIO_NOT_FOUND",
        details: null,
      });
    }

    if (!bookingDate || typeof bookingDate !== "string") {
      throw studioValidationError("bookingDate is required.");
    }
    if (!startTime || typeof startTime !== "string" || !endTime || typeof endTime !== "string") {
      throw studioValidationError("startTime and endTime are required.");
    }

    const startDateTime = new Date(`${bookingDate}T${startTime}`);
    const endDateTime = new Date(`${bookingDate}T${endTime}`);
    if (Number.isNaN(startDateTime.getTime()) || Number.isNaN(endDateTime.getTime())) {
      throw studioValidationError("Invalid date or time.");
    }
    if (startDateTime < new Date(Date.now() - 60 * 1000)) {
      throw studioValidationError("Date cannot be in the past.");
    }
    if (endDateTime <= startDateTime) {
      throw studioValidationError("End time must be after start time.");
    }

    const durationMs = endDateTime.getTime() - startDateTime.getTime();
    const durationHours = durationMs / (1000 * 60 * 60);
    if (durationHours <= 0 || durationHours > 24) {
      throw studioValidationError("Invalid booking duration.");
    }

    // Check for overlapping confirmed bookings
    const overlapping = await db.collection("bookings").findOne({
      studioId: String(studio._id),
      status: "Confirmed",
      $or: [
        {
          startAt: { $lt: endDateTime },
          endAt: { $gt: startDateTime },
        },
      ],
    });
    if (overlapping) {
      return response.status(409).json({
        success: false,
        message: "This time slot is not available.",
        code: "BOOKING_CONFLICT",
        details: null,
      });
    }

    const hourlyRateSnapshot = typeof studio.hourlyRate === "number" ? studio.hourlyRate : Number(studio.hourlyRate) || 0;
    const totalAmount = Math.round(hourlyRateSnapshot * durationHours * 100) / 100;

    const now = new Date();
    const booking = {
      _id: new ObjectId(),
      studioId: String(studio._id),
      studioSlug: studio.slug,
      studioTitle: studio.title,
      studioImage: studio.image,
      studioLocation: studio.location,
      userId,
      userEmail,
      userName,
      bookingDate,
      startTime,
      endTime,
      startAt: startDateTime,
      endAt: endDateTime,
      duration: durationHours,
      hourlyRateSnapshot,
      totalAmount,
      status: "Pending",
      createdAt: now,
      updatedAt: now,
    };

    await db.collection("bookings").insertOne(booking);

    return response.status(201).json({
      success: true,
      message: "Booking request submitted",
      data: {
        id: String(booking._id),
        ...booking,
        _id: undefined,
      },
    });
  });

  app.get("/api/bookings/mine", authenticate, async (request, response) => {
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
    const userId = typeof user?.id === "string" ? user.id.trim() : "";
    if (!userId) {
      return response.status(401).json({
        success: false,
        message: "Authentication is required",
        code: "UNAUTHENTICATED",
        details: null,
      });
    }
    const bookings = await db
      .collection("bookings")
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();
    return response.status(200).json({
      success: true,
      message: "Bookings retrieved successfully",
      data: bookings.map((b) => ({ id: String(b._id), ...b, _id: undefined })),
    });
  });

  app.patch("/api/bookings/:id/cancel", authenticate, async (request, response) => {
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
    const userId = typeof user?.id === "string" ? user.id.trim() : "";
    if (!userId) {
      return response.status(401).json({
        success: false,
        message: "Authentication is required",
        code: "UNAUTHENTICATED",
        details: null,
      });
    }
    const { id } = request.params;
    let bookingId;
    try {
      bookingId = new ObjectId(id);
    } catch {
      return response.status(404).json({
        success: false,
        message: "Booking not found",
        code: "BOOKING_NOT_FOUND",
        details: null,
      });
    }
    const booking = await db.collection("bookings").findOne({ _id: bookingId });
    if (!booking) {
      return response.status(404).json({
        success: false,
        message: "Booking not found",
        code: "BOOKING_NOT_FOUND",
        details: null,
      });
    }
    if (booking.userId !== userId) {
      return response.status(403).json({
        success: false,
        message: "You do not have permission to cancel this booking",
        code: "FORBIDDEN",
        details: null,
      });
    }
    if (booking.status !== "Pending") {
      return response.status(400).json({
        success: false,
        message: "Only pending bookings can be cancelled",
        code: "INVALID_BOOKING_STATUS",
        details: null,
      });
    }
    await db.collection("bookings").updateOne(
      { _id: bookingId },
      { $set: { status: "Cancelled", updatedAt: new Date() } },
    );
    const updated = await db.collection("bookings").findOne({ _id: bookingId });
    return response.status(200).json({
      success: true,
      message: "Booking cancelled successfully",
      data: { id: String(updated._id), ...updated, _id: undefined },
    });
  });
}

export async function startServer() {
  const config = loadConfig();

  if (config.nodeEnv === "production" && config.clientOrigins.length === 0) {
    throw new Error(
      "CLIENT_URL is required in production for credentialed CORS.",
    );
  }

  if (config.nodeEnv === "production" && !config.mongodbUri) {
    throw new Error(
      "MONGODB_URI is required in production; the server was not started.",
    );
  }

  if (config.mongodbUri) {
    let database;
    try {
      database = await connectDatabase({
        uri: config.mongodbUri,
        databaseName: config.mongodbDbName,
      });
      console.info("MongoDB connection established and verified.");
    } catch {
      throw new Error(
        "MongoDB connection failed. Check MONGODB_URI, MONGODB_DB_NAME, network access, and credentials.",
      );
    }

    // Index creation is a performance concern only, so it never affects startup.
    try {
      const indexResult = await ensureCollectionIndexes(database);
      for (const failure of indexResult.failed) {
        console.warn(
          `Skipping index ${failure.collection}.${failure.name}: ${failure.reason}`,
        );
      }
      if (indexResult.created.length > 0) {
        console.info(
          `Verified ${indexResult.created.length} MongoDB index(es): ${indexResult.created.join(", ")}.`,
        );
      }
    } catch (error) {
      console.warn(
        `MongoDB index setup was skipped: ${error?.message || "unknown error"}`,
      );
    }
  } else {
    console.warn(
      "MONGODB_URI is not configured; starting in development degraded mode. Readiness will return 503.",
    );
  }

  const authenticate = createRequireAuth({
    issuer: config.clientAuthUrl,
    jwksResolver: getRemoteJwksResolver(
      `${config.clientAuthUrl}/api/auth/jwks`,
    ),
  });

  const app = createApp({
    clientOrigins: config.clientOrigins,
    getDatabaseStatus,
    registerRoutes: (expressApp) =>
      registerStudioRoutes(expressApp, {
        getDatabase,
        authenticate,
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
