import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
} from "jose";

const SESSION_COOKIE_NAMES = [
  "better-auth.session_data",
  "__Secure-better-auth.session_data",
  "better-auth-session_data",
  "__Secure-better-auth-session_data",
];
const SESSION_CACHE_JWT_TYPE = "better-auth.session-cache+jwt";
const SESSION_CACHE_JWT_AUDIENCE = "better-auth:session-cache";
const MAX_SESSION_COOKIE_CHUNKS = 100;
const MAX_SESSION_COOKIE_LENGTH = 405000;
const jwksResolvers = new Map();

export class JwksUnavailableError extends Error {
  constructor() {
    super("Authentication signing keys are unavailable.");
    this.name = "JwksUnavailableError";
  }
}

export function getRemoteJwksResolver(jwksUrl) {
  const cached = jwksResolvers.get(jwksUrl);
  if (cached) return cached;

  const resolver = createRemoteJWKSet(new URL(jwksUrl), {
    cacheMaxAge: 5 * 60 * 1000,
    cooldownDuration: 30 * 1000,
    timeoutDuration: 5 *  1000,
    [customFetch]: async (url, options) => {
      let response;
      try {
        response = await fetch(url, options);
      } catch {
        throw new JwksUnavailableError();
      }
      if (response.status !== 200) throw new JwksUnavailableError();
      return response;
    },
  });
  jwksResolvers.set(jwksUrl, resolver);
  return resolver;
}

export function readSessionDataCookie(cookieHeader) {
  if (typeof cookieHeader !== "string" || !cookieHeader) return null;

  const cookieValues = new Map();
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;

    const name = pair.slice(0, separator).trim();
    const rawValue = pair.slice(separator + 1).trim();
    const baseName = SESSION_COOKIE_NAMES.find(
      (candidate) =>
        name === candidate || name.startsWith(`${candidate}.`),
    );
    if (!baseName) continue;
    if (cookieValues.has(name)) return null;

    let value = rawValue;
    if (
      value.length >= 2 &&
      value.startsWith('"') &&
      value.endsWith('"')
    ) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
    cookieValues.set(name, { baseName, value });
  }

  const baseNames = new Set(
    [...cookieValues.values()].map(({ baseName }) => baseName),
  );
  if (baseNames.size !== 1) return null;

  const [baseName] = baseNames;
  const rootValue = cookieValues.get(baseName)?.value;
  const chunks = [];
  for (const [name, entry] of cookieValues) {
    if (name === baseName) continue;
    const suffix = name.slice(baseName.length + 1);
    if (!/^(?:0|[1-9]\d*)$/.test(suffix)) return null;
    const index = Number(suffix);
    if (
      !Number.isSafeInteger(index) ||
      index >= MAX_SESSION_COOKIE_CHUNKS
    ) {
      return null;
    }
    chunks.push({ index, value: entry.value });
  }

  if (rootValue !== undefined && chunks.length > 0) return null;
  if (rootValue !== undefined) {
    return rootValue.length <= MAX_SESSION_COOKIE_LENGTH ? rootValue : null;
  }
  if (chunks.length === 0) return null;

  chunks.sort((left, right) => left.index - right.index);
  if (chunks.some(({ index }, position) => index !== position)) return null;

  const token = chunks.map(({ value }) => value).join("");
  return token.length <= MAX_SESSION_COOKIE_LENGTH ? token : null;
}

function isValidIdentity(payload) {
  if (!payload || typeof payload !== "object") return false;
  const { session, user } = payload;
  if (!session || typeof session !== "object") return false;
  if (!user || typeof user !== "object") return false;
  if (
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    typeof payload.sub !== "string" ||
    typeof payload.sid !== "string" ||
    typeof user.id !== "string" ||
    typeof user.name !== "string" ||
    typeof user.email !== "string" ||
    typeof session.id !== "string" ||
    typeof session.token !== "string" ||
    typeof session.userId !== "string" ||
    typeof session.expiresAt !== "string"
  ) {
    return false;
  }

  const id = user.id.trim();
  const name = user.name.trim();
  const email = user.email.trim();
  const sessionExpiresAt = Date.parse(session.expiresAt);
  if (
    !id ||
    id.length > 512 ||
    !name ||
    name.length > 200 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 320 ||
    payload.sub !== id ||
    payload.sid !== session.token ||
    session.userId !== id ||
    !Number.isFinite(sessionExpiresAt) ||
    sessionExpiresAt <= Date.now()
  ) {
    return false;
  }

  if (user.image !== undefined && user.image !== null) {
    if (typeof user.image !== "string" || user.image.length > 2048) {
      return false;
    }
    // An empty value simply means "no profile photo"; only real URLs are validated.
    const imageUrl = user.image.trim();
    if (imageUrl) {
      try {
        const image = new URL(imageUrl);
        if (!["http:", "https:"].includes(image.protocol)) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}

function unauthenticated(response) {
  return response.status(401).json({
    success: false,
    message: "Authentication is required",
    code: "UNAUTHENTICATED",
    details: null,
  });
}

function authenticationUnavailable(response) {
  return response.status(503).json({
    success: false,
    message: "Authentication verification is unavailable",
    code: "AUTHENTICATION_UNAVAILABLE",
    details: null,
  });
}

export function createRequireAuth({ issuer, jwksResolver }) {
  if (typeof issuer !== "string" || !issuer) {
    throw new Error("A canonical Client authentication issuer is required.");
  }
  if (typeof jwksResolver !== "function") {
    throw new Error("A Client JWKS resolver is required.");
  }

  return async (request, response, next) => {
    const token = readSessionDataCookie(request.headers.cookie);
    if (!token) return unauthenticated(response);

    let verified;
    try {
      verified = await jwtVerify(token, jwksResolver, {
        algorithms: ["EdDSA"],
        audience: SESSION_CACHE_JWT_AUDIENCE,
        clockTolerance: 15,
        issuer,
      });
    } catch (error) {
      if (
        error instanceof JwksUnavailableError ||
        [
          "ERR_JWKS_TIMEOUT",
          "ERR_JWKS_INVALID",
          "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
          "ERR_JOSE_GENERIC",
        ].includes(error?.code)
      ) {
        return authenticationUnavailable(response);
      }
      return unauthenticated(response);
    }

    const { payload, protectedHeader } = verified;
    if (
      protectedHeader.typ !== SESSION_CACHE_JWT_TYPE ||
      !isValidIdentity(payload)
    ) {
      return unauthenticated(response);
    }

    const user = {
      id: payload.user.id.trim(),
      name: payload.user.name.trim(),
      email: payload.user.email.trim(),
      ...(typeof payload.user.image === "string" && payload.user.image.trim()
        ? { image: payload.user.image.trim() }
        : {}),
    };
    request.user = user;
    return next();
  };
}
