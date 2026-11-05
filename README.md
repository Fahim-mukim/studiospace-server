# StudioSpace Server

StudioSpace Server is an independent Express.js REST API. It owns marketplace
records in MongoDB and communicates with the separate Next.js Client over
HTTP. Each application has its own repository, package manifest, environment,
Git history, and deployment; neither repository imports files from the other.

## Requirements and setup

- Node.js 20.19.0 or later
- npm compatible with the installed Node.js release

```sh
npm install
cp .env.example .env
npm run dev
```

In PowerShell, use `Copy-Item .env.example .env`. Do not commit `.env` or put
credentials in source control. `.env.example` contains sample values only.

| Variable | Purpose | Example/default |
|---|---|---|
| `PORT` | HTTP port | `5000` |
| `CLIENT_URL` | Exact browser origin(s) allowed by credentialed CORS; comma-separated for multiple origins | `http://localhost:3000` |
| `MONGODB_URI` | Server's MongoDB connection URI | `mongodb://127.0.0.1:27017` in `.env.example` |
| `MONGODB_DB_NAME` | MongoDB database name | `studiospace` |
| `CLIENT_AUTH_URL` | Canonical Next.js origin used as JWT issuer and JWKS base | `http://localhost:3000` in development |
| `NODE_ENV` | Runtime environment | `development` |

Development adds `http://localhost:3000` to the allowed origins. Production
requires explicit `CLIENT_URL`, an HTTPS `CLIENT_AUTH_URL`, and `MONGODB_URI`.
When `MONGODB_URI` is supplied to the Server, `MONGODB_DB_NAME` is also
required.

## Authentication and CORS

Better Auth is owned by the independent Next.js Client. This Server does not
implement signup, login, logout, or Google OAuth handlers and does not own
authentication credentials. The Client's Better Auth runtime persists
`user`, `account`, `session`, and `jwks` records. The Server uses its own
MongoDB connection for marketplace collections such as `studios` and
`bookings`; both runtimes may use the same database. The browser never connects
directly to MongoDB.

Protected API routes use `jose` to verify the Client's short-lived signed
session-data cookie against remote JWKS:

```text
Issuer:   CLIENT_AUTH_URL
JWKS:     CLIENT_AUTH_URL/api/auth/jwks
Audience: better-auth:session-cache
Cookie:   better-auth.session_data (including secure/chunked variants)
```

The verifier checks the EdDSA signature, issuer, audience, token type,
expiration, and signed user/session identity before setting `request.user`.
Ownership is derived from that verified identity; client-submitted user IDs
are not trusted. The opaque `better-auth.session_token` cookie is not a JWT
and is never used for verification. The JWKS resolver is cached per URL.
Missing or invalid credentials return HTTP 401; an unavailable JWKS service
returns HTTP 503. Since the Client's session-data JWT is a cached session
representation, logout or revocation can take up to its configured 60-second
cache lifetime to be reflected by this API.

`CLIENT_URL` controls exact credentialed CORS origins; wildcard origins are
not used. `CLIENT_AUTH_URL` is the canonical authentication issuer. Credentialed
CORS alone does not send a cookie set for one host to a different API host.
Better Auth cookies are host-only by default, and browser `SameSite` and
third-party-cookie policies may further limit direct Client-to-Server cookie
transport. Production domains and cookie transport have not been verified.
Before relying on cross-origin authenticated calls in production, use a
same-origin Next.js proxy/BFF or deliberately configure and verify a compatible
shared cookie domain and policy. Do not weaken secure cookie settings as a
workaround.

## HTTP API

Unless stated otherwise, errors use this JSON shape:

```json
{
  "success": false,
  "message": "A safe explanation",
  "code": "ERROR_CODE",
  "details": null
}
```

Malformed JSON returns HTTP 400 (`INVALID_JSON`); JSON bodies over 1 MiB return
HTTP 413 (`PAYLOAD_TOO_LARGE`). Unexpected errors return HTTP 500
(`INTERNAL_SERVER_ERROR`) without stack traces or database internals. Unknown
paths return HTTP 404 (`ROUTE_NOT_FOUND`).

### Health and readiness

| Method and path | Auth | Behavior and responses |
|---|---|---|
| `GET /api/health` | None | HTTP 200 when the Express process is running; does not depend on MongoDB. |
| `GET /api/ready` | None | HTTP 200 when MongoDB is connected and passed its startup ping; otherwise HTTP 503 with `DATABASE_NOT_READY`. |

### Studios

Studio records are stored in the MongoDB `studios` collection. Public responses
serialize MongoDB `_id` as string `id` and omit private owner fields.
Database-unavailable studio requests return HTTP 503 (`DATABASE_NOT_READY`).

#### `GET /api/studios`

Public, paginated list. Supported query parameters:

| Parameter | Validation and behavior |
|---|---|
| `category` | Optional exact slug: `photo-studios`, `sound-stages`, `podcast-rooms`, `music-suites`, or `art-workshops`. |
| `search` | Optional string, at most 100 characters; trimmed and escaped, case-insensitive search over title/name, location, category, overview, and amenities. |
| `minPrice`, `maxPrice` | Optional non-negative numbers; inclusive `hourlyRate` bounds. `minPrice` cannot exceed `maxPrice`. |
| `sort` | `newest` (default), `price-low`, or `price-high`. |
| `page` | Positive integer; default `1`. |
| `limit` | Positive integer; default `20`, maximum `100`. |

Returns HTTP 200 with `data` and `pagination` (`page`, `limit`, `total`,
`totalPages`). Invalid query values return HTTP 400 (`INVALID_QUERY`). Filtering,
counting, sorting, and pagination run against MongoDB.

```text
GET /api/studios?limit=6&sort=newest
GET /api/studios?category=photo-studios&minPrice=50&maxPrice=120
GET /api/studios?search=daylight&page=1&limit=10
```

#### `GET /api/studios/:id`

Public lookup by a 24-character MongoDB ObjectId or exact slug. Returns HTTP
200 with a serialized record, HTTP 404 (`STUDIO_NOT_FOUND`) if absent, or
HTTP 503 if MongoDB is unavailable.

#### `POST /api/studios`

Authenticated with a valid Client session-data JWT; inserts a new record in
`studios` and returns HTTP 201. Send credentialed browser requests from a
configured Client origin.

Request fields:

| Field | Validation |
|---|---|
| `title` | Required trimmed string, 3–100 characters |
| `categorySlug` | Required supported category slug |
| `hourlyRate` | Required finite positive number |
| `securityDeposit` | Required finite non-negative number |
| `capacity` | Required positive safe integer |
| `location` | Required trimmed string, 2–160 characters |
| `image` | Required HTTP(S) URL, at most 2,048 characters |
| `imageAlt` | Optional trimmed string, at most 250 characters |
| `amenities` | Required array of 1–20 non-empty strings, each at most 80 characters; case-insensitive duplicates are removed |
| `overview` | Required trimmed string, 30–2,000 characters |

Unknown fields are rejected with HTTP 400 (`VALIDATION_ERROR`). Recognized
server-managed fields may be present but are ignored. The API derives category
label, ObjectId, unique slug, timestamps, initial `reviewCount`, owner identity,
and public host fields. Owner data comes from verified `request.user`, never
from the request body. This endpoint accepts an already available image URL;
it does not upload files.

Other responses: HTTP 401 (`UNAUTHENTICATED` or `AUTH_USER_INCOMPLETE`), HTTP
503 (`AUTHENTICATION_UNAVAILABLE` or `DATABASE_NOT_READY`), and HTTP 500 for
unexpected failures.

#### `GET /api/studios/mine`

Authenticated. Returns HTTP 200 with studios filtered by verified `request.user.id`,
newest first; no records returns an empty `data` array. Does not accept an
owner ID from query/body. Returns HTTP 401 for missing/incomplete identity,
HTTP 503 if authentication verification or MongoDB is unavailable, or HTTP 500
for unexpected failures.

#### `PATCH /api/studios/:id`

Authenticated partial update by ObjectId or slug. The Server looks up the
record, then compares its stored `ownerId` with the verified user ID. Only the
owner can update; a non-owner receives HTTP 403 (`FORBIDDEN`), a missing studio
HTTP 404 (`STUDIO_NOT_FOUND`).

Editable fields and validation follow `POST /api/studios`; all are optional in
a patch. At least one editable field is required. `imageAlt` can be cleared
with an empty string or `null`. Unknown fields and invalid values return HTTP
400 (`VALIDATION_ERROR`); submitted owner/server-managed fields cannot change
stored ownership. Success updates `updatedAt` and returns HTTP 200 with the
public record. Authentication failures return HTTP 401; unavailable JWKS or
MongoDB returns HTTP 503.

There is **no Delete Studio endpoint**.

### Bookings

Booking records are stored in the MongoDB `bookings` collection. All three
booking endpoints require a valid Client session-data JWT. The Server derives
user ID, email, and name from the verified identity.

#### `POST /api/bookings`

Request fields:

| Field | Validation and behavior |
|---|---|
| `studioId` | Required ObjectId string or studio slug; nonexistent studio returns HTTP 404 (`STUDIO_NOT_FOUND`). |
| `bookingDate` | Required string combined with start/end time and parsed as a date/time. Past starts are rejected. |
| `startTime`, `endTime` | Required strings; end must follow start and duration must be at most 24 hours. |

The Server snapshots the stored studio hourly rate and calculates
`round(hourlyRate × durationHours, 2)`. Security deposit is not included.
Successful insertion returns HTTP 201 and creates a `Pending` booking; success
does not mean host confirmation.

Before insertion the handler looks for an overlapping `Confirmed` booking for
the studio. A match returns HTTP 409 (`BOOKING_CONFLICT`). This is a
find-then-insert check, not an atomic reservation: concurrent requests can race,
and pending requests do not block one another. There is no host approval or
confirmation endpoint. Current routes create `Pending` and transition a
pending booking to `Cancelled`; they do not create `Confirmed` or `Completed`
records.

Invalid fields return HTTP 400 (`VALIDATION_ERROR`); missing/invalid identity
returns HTTP 401; JWKS or database unavailability returns HTTP 503; unexpected
errors return HTTP 500.

#### `GET /api/bookings/mine`

Returns HTTP 200 with only records whose `userId` matches the verified
identity, sorted newest first. No bookings returns an empty array. Missing
identity returns HTTP 401; unavailable JWKS or MongoDB returns HTTP 503.

#### `PATCH /api/bookings/:id/cancel`

The path ID must be a MongoDB ObjectId. The endpoint only allows the booking's
verified owner to cancel a `Pending` record, changing its status to `Cancelled`
and updating `updatedAt`; success returns HTTP 200. Malformed or absent booking
returns HTTP 404 (`BOOKING_NOT_FOUND`), another user's booking HTTP 403
(`FORBIDDEN`), and a non-pending booking HTTP 400 (`INVALID_BOOKING_STATUS`).
Authentication or database failures return HTTP 401 or 503, respectively.

### Reviews and unsupported operations

There are no review routes, booking approval/confirmation routes, or studio
deletion route in the current Server source. Do not infer these capabilities
from fields rendered by the Client.

## MongoDB, indexes, and seed data

The Server uses the MongoDB Node.js driver and one reusable `MongoClient`
connection in `src/config/database.js`, selecting `MONGODB_DB_NAME` and pinging
the database at startup. No in-memory fallback exists. In development, missing
`MONGODB_URI` permits a degraded HTTP process with readiness 503; in production
it prevents startup. Connection failures are reported without returning
credentials or raw driver details.

`src/config/indexes.js` declares these booking indexes:

| Collection | Index | Keys |
|---|---|---|
| `bookings` | `bookings_user_createdAt` | `{ userId: 1, createdAt: -1 }` |
| `bookings` | `bookings_studio_status_window` | `{ studioId: 1, status: 1, startAt: 1, endAt: 1 }` |

When configured, the Server attempts index creation during startup. Repeated
creation of matching indexes is idempotent. A per-index failure is logged and
does not block startup. These indexes improve lookup performance; they do not
provide atomic booking-overlap enforcement.

`npm run seed:studios` runs `scripts/seed-studios.js`, which inserts six demo
studio records into the `studios` collection. It requires `MONGODB_URI` and
uses `MONGODB_DB_NAME` or defaults to `studiospace`. It checks each deterministic
`seedId` before insert, so repeat runs skip already-seeded records; it does not
update existing seed records or clear collections. The seed command was not
run as part of this documentation audit.

## Tests and scripts

```sh
npm run dev
npm start
npm test
npm run check
npm run seed:studios
```

`npm test` uses Node's built-in test runner. Existing tests cover health and
readiness, environment configuration, credentialed CORS, error responses,
JWT/JWKS verification and studio route behavior, and index declarations.
There are no dedicated booking endpoint tests. Server auth tests use generated
test JWTs; they do not perform Better Auth signup or MongoDB authentication
persistence integration. `npm run check` runs `node --check` on the listed
server and test files.

## Client integration and limitations

The separate Next.js Client configures its Express API origin with
`NEXT_PUBLIC_API_BASE_URL` (local default `http://localhost:5000`). The current
Client uses the Server's public studio reads and protected create/list/update
routes, plus booking create/list/cancel routes. Client and Server must be
configured independently, and production cookie transport between their
domains remains to be verified.

This README and the Client's
[requirement traceability](https://github.com/Fahim-mukim/studiospace-client/blob/main/docs/requirement-traceability.md)
describe implemented endpoints and known gaps; they are not certification
against the original assignment, which has not been located.
