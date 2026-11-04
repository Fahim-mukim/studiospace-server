# StudioSpace Server

The StudioSpace Server is the independent Express.js REST API application.
It provides health/readiness endpoints, MongoDB-backed public studio reads,
and protected studio creation. The independently maintained Next.js Client
owns BetterAuth and communicates with this Server through HTTP APIs.

## Requirements

- Node.js 20.19.0 or later
- npm compatible with the installed Node.js release

The MongoDB Node.js driver 7.8 requires Node.js 20.19.0 or later.

## Setup

From this repository:

```sh
npm install
```

Copy `.env.example` to `.env` and set values for the local environment:

```sh
cp .env.example .env
```

PowerShell equivalent:

```powershell
Copy-Item .env.example .env
```

Do not commit `.env` or put credentials in source control. `.env.example`
contains only safe sample values.

| Variable | Purpose | Default / example |
|---|---|---|
| `PORT` | HTTP port | `5000` |
| `CLIENT_URL` | Exact allowed client origin(s); multiple origins may be comma-separated | `http://localhost:3000` |
| `MONGODB_URI` | MongoDB connection URI | `mongodb://127.0.0.1:27017` in `.env.example` |
| `MONGODB_DB_NAME` | Database selected by the driver | `studiospace` |
| `CLIENT_AUTH_URL` | Canonical Next.js origin used as the JWT issuer and JWKS endpoint base | `http://localhost:3000` in development |
| `NODE_ENV` | Runtime environment | `development` |

Development always allows the `http://localhost:3000` origin in addition to
the origins configured through `CLIENT_URL`. Other origins are not allowed.
Credentialed CORS is enabled only for an exact configured origin; wildcard
origins are not used.

## Authentication

BetterAuth is owned by the independent Next.js Client, not this Express
Server. This Server does not expose BetterAuth signup/login/logout handlers,
configure Google OAuth, or own authentication credentials or persistence.
The Client remains responsible for signup, login, OAuth, session management,
and its BetterAuth MongoDB `user`, `account`, `session`, and JWKS records.
The browser must never connect to MongoDB directly.

For protected API requests, this Server verifies the Client's short-lived
JWT-backed session-data cookie using `jose` and the Client's remote JWKS
endpoint:

```text
Issuer:   CLIENT_AUTH_URL
JWKS:     CLIENT_AUTH_URL/api/auth/jwks
Audience: better-auth:session-cache
Cookie:   better-auth.session_data (or its secure/chunked variant)
```

The verifier checks the EdDSA signature, issuer, audience, token type,
expiration, and consistency of the signed user/session identity before
attaching `request.user`. It never accepts a client-submitted user ID as
identity. The opaque `better-auth.session_token` cookie is not a JWT and is
never used for verification. A valid session-data cookie is an optimistic
cached representation, so logout or session invalidation may take up to the
Client's configured 60-second cache lifetime to be reflected by this API.
Missing or invalid credentials return HTTP 401; unavailable JWKS verification
returns HTTP 503. JWKS resolvers are reused per endpoint.

`CLIENT_URL` controls the exact allowed browser origins for credentialed CORS.
`CLIENT_AUTH_URL` is separately the canonical Client issuer origin. In local
development these are typically `http://localhost:3000`; the Express API uses
`http://localhost:5000`.

### Cookie and deployment limitation

Credentialed CORS does not transfer a cookie between hosts. BetterAuth's
HTTP-only cookies are host-only by default, so a cookie set for the Next.js
host is not automatically sent to a different Express API host. `SameSite`
and browser third-party-cookie policies can impose additional restrictions.
Production Client/Server domains were not available to verify. Before relying
on direct browser-to-Express authentication in production, use a same-origin
Next.js proxy/BFF or deliberately configure and verify a compatible shared
cookie domain and cross-origin cookie policy. Do not weaken secure cookie
settings as a workaround. The Server-side JWT verifier is in place, but
production cookie transport is not yet confirmed.

### Authentication test coverage

Server tests generate signed test JWTs and exercise the real verifier and
protected `/api/studios` route, including invalid claims, JWKS failures,
identity-derived ownership, and rejection of unauthenticated requests. They
do not test BetterAuth or MongoDB authentication persistence. Real signup,
credential/session persistence, cookie issuance, and logout integration tests
belong to the Next.js Client repository, which owns that authentication
instance and its dedicated opt-in MongoDB integration test.

## Run

Start the development server with automatic restarts:

```sh
npm run dev
```

Start the server as a production process:

```sh
npm start
```

Run automated tests and JavaScript syntax checks:

```sh
npm test
npm run check
```

## Database and service checks

When `MONGODB_URI` is configured, startup explicitly connects using one
reusable MongoDB client, selects `MONGODB_DB_NAME`, and verifies connectivity
with a ping. Connection failures stop startup with a safe message; credentials
and raw driver errors are not logged or returned to clients.

In development, a missing `MONGODB_URI` starts the HTTP service in a clearly
logged degraded mode. Liveness remains available, while readiness reports
HTTP 503. In production, a missing `MONGODB_URI` prevents startup. No
in-memory database fallback is used.

- `GET /api/health` is a liveness check. HTTP 200 means the Express process is
  running; it does not depend on MongoDB.
- `GET /api/ready` is a readiness check. HTTP 200 means MongoDB connected and
  passed its startup ping; otherwise it returns HTTP 503.

## Public studio read APIs

Studio reads use the MongoDB `studios` collection through the shared database
connection. They return stored database records only; the illustrative
frontend fixtures are not copied into MongoDB or returned as fallback data.
If MongoDB is unavailable, both routes return HTTP 503 with
`DATABASE_NOT_READY`.

### `GET /api/studios`

Returns a paginated list. Supported query parameters:

| Parameter | Meaning |
|---|---|
| `category` | One of `photo-studios`, `sound-stages`, `podcast-rooms`, `music-suites`, or `art-workshops` |
| `search` | Case-insensitive search across title/name, location, category, overview, and amenities |
| `minPrice`, `maxPrice` | Inclusive non-negative `hourlyRate` bounds |
| `sort` | `newest` (default), `price-low`, or `price-high` |
| `page` | Positive page number (default `1`) |
| `limit` | Positive page size (default `20`, maximum `100`) |

Example requests:

```text
GET http://localhost:5000/api/studios
GET http://localhost:5000/api/studios?limit=6&sort=newest
GET http://localhost:5000/api/studios?category=photo-studios&minPrice=50&maxPrice=120
GET http://localhost:5000/api/studios?search=daylight&page=1&limit=10
```

Successful responses contain public studio fields with MongoDB `_id`
serialized as the string `id`:

```json
{
  "success": true,
  "message": "Studios retrieved successfully",
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 0,
    "totalPages": 0
  }
}
```

Invalid filters return HTTP 400 with `code: "INVALID_QUERY"`. The endpoint
uses database-side filtering, counting, sorting, and pagination; search input
is escaped and sort values are allowlisted.

### `GET /api/studios/:id`

Looks up one studio by a 24-character MongoDB ObjectId or by its `slug`.

```text
GET http://localhost:5000/api/studios/65c7a6b0c9d2fddc4493e001
GET http://localhost:5000/api/studios/daylight-photo-studio
```

Success returns HTTP 200 and a single serialized public studio in `data`.
An unknown studio returns HTTP 404:

```json
{
  "success": false,
  "message": "Studio not found",
  "code": "STUDIO_NOT_FOUND",
  "details": null
}
```

Studio update/delete, booking, and client API integration are not included in
this milestone.

### `POST /api/studios`

Creates one studio in the MongoDB `studios` collection. This endpoint requires
a valid JWT-backed session-data cookie issued by the Next.js Client; send
credentialed requests from a configured client origin. It uses the same
shared MongoDB connection as the public GET endpoints.

The client submits these fields:

| Field | Validation |
|---|---|
| `title` | Required trimmed string, 3–100 characters |
| `categorySlug` | Required; `photo-studios`, `sound-stages`, `podcast-rooms`, `music-suites`, or `art-workshops` |
| `hourlyRate` | Required finite positive number |
| `securityDeposit` | Required finite non-negative number |
| `capacity` | Required positive safe integer |
| `location` | Required trimmed string, 2–160 characters |
| `image` | Required valid HTTP(S) URL (maximum 2,048 characters) |
| `imageAlt` | Optional trimmed string, maximum 250 characters |
| `amenities` | Required array of 1–20 non-empty strings, each at most 80 characters; duplicate values are removed |
| `overview` | Required trimmed description, 30–2,000 characters |

`image` is the resulting URL after the separate client-side image upload flow;
this API does not upload files or manage image-host credentials. The server
derives the display `category` from `categorySlug`, generates the ObjectId and
unique slug, timestamps, and initial `reviewCount`, and derives `ownerId`,
lowercase `ownerEmail`, `ownerName`, and the public `host` display fields from
the authenticated BetterAuth user. Submitted ownership or server-managed
fields are ignored and cannot override those values. Owner email and other
private ownership fields are never included in public studio responses.

Example request (the opaque `session_token` is not accepted as a JWT):

```http
POST /api/studios
Content-Type: application/json
Cookie: better-auth.session_data=<JWT>
```

```json
{
  "title": "Daylight Photo Studio",
  "categorySlug": "photo-studios",
  "hourlyRate": 95,
  "securityDeposit": 150,
  "capacity": 8,
  "location": "Brooklyn, New York",
  "image": "https://images.example.com/daylight-studio.jpg",
  "imageAlt": "A bright photography studio",
  "amenities": ["Natural light", "Backdrop", "Changing area"],
  "overview": "A detailed description of the studio and its creative space."
}
```

Success returns HTTP 201 and the safe public studio representation:

```json
{
  "success": true,
  "message": "Studio created successfully",
  "data": {
    "id": "65c7a6b0c9d2fddc4493e001",
    "title": "Daylight Photo Studio",
    "slug": "daylight-photo-studio-65c7a6b0c9d2fddc4493e001",
    "category": "Photo Studios",
    "categorySlug": "photo-studios"
  }
}
```

Validation errors return HTTP 400:

```json
{
  "success": false,
  "message": "hourlyRate must be a finite positive number.",
  "code": "VALIDATION_ERROR",
  "details": null
}
```

Missing or invalid JWT-backed session cookies return HTTP 401 with
`code: "UNAUTHENTICATED"`. If the Client JWKS endpoint cannot be reached,
verification returns HTTP 503 with `code: "AUTHENTICATION_UNAVAILABLE"`. If
MongoDB is unavailable after authentication, the endpoint returns HTTP 503
with `code: "DATABASE_NOT_READY"`. Database errors use the standard generic
HTTP 500 response without MongoDB internals.

The created studio can be fetched immediately with
`GET /api/studios/<slug>` or `GET /api/studios/<id>`, and also appears in
`GET /api/studios`.

## Project boundaries and roadmap

This repository is independent of
[`studiospace-client`](https://github.com/Fahim-mukim/studiospace-client), with
its own package manifest, lockfile, environment, Git history, and deployment.
No client files or shared imports belong in this repository. Future client
integration will use a configurable HTTP API base URL.

Studio update/delete, reviews, and booking APIs remain future milestones. The
separately maintained client is not modified by server authentication or studio
creation work.
