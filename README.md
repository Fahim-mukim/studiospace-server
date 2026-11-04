# StudioSpace Server

The StudioSpace Server is the independent Express.js REST API application.
It currently provides process health/readiness endpoints and a reusable
MongoDB connection foundation. The Next.js client is maintained, configured,
and deployed separately; the projects communicate only through HTTP APIs.

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
| `NODE_ENV` | Runtime environment | `development` |

Development always allows the `http://localhost:3000` origin in addition to
the origins configured through `CLIENT_URL`. Other origins are not allowed.
Credentialed CORS is enabled only for an exact configured origin; wildcard
origins are not used.

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

No studio create/update/delete, authentication, booking, or client API
integration is included in this milestone.

## Project boundaries and roadmap

This repository is independent of
[`studiospace-client`](https://github.com/Fahim-mukim/studiospace-client), with
its own package manifest, lockfile, environment, Git history, and deployment.
No client files or shared imports belong in this repository. Future client
integration will use a configurable HTTP API base URL.

Authentication, studio listing/CRUD, reviews, and booking APIs are future
milestones and are not implemented here.
