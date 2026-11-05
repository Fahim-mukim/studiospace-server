/**
 * Declarative MongoDB index definitions for collections owned by the Server.
 *
 * Index creation is idempotent: MongoDB returns success when an identical index
 * already exists, so this can run on every startup without duplicating work.
 * A failure never blocks startup — indexes are a performance concern, not a
 * correctness gate.
 */
export const collectionIndexes = {
  bookings: [
    // GET /api/bookings/mine reads a user's booking history sorted by recency.
    {
      name: "bookings_user_createdAt",
      key: { userId: 1, createdAt: -1 },
    },
    // POST /api/bookings overlap lookup filters by studio + status and then
    // compares startAt/endAt, so the leading keys serve both the availability
    // check and any studio-scoped status/time query.
    {
      name: "bookings_studio_status_window",
      key: { studioId: 1, status: 1, startAt: 1, endAt: 1 },
    },
  ],
};

/**
 * Creates the declared indexes on each collection.
 *
 * @param {import("mongodb").Db | null | undefined} db
 * @param {Record<string, Array<{ name: string, key: Record<string, 1 | -1 }>>} [definitions]
 * @returns {Promise<{ created: string[], failed: Array<{ collection: string, name: string, reason: string }> }>}
 */
export async function ensureCollectionIndexes(db, definitions = collectionIndexes) {
  const result = { created: [], failed: [] };
  if (!db) return result;

  for (const [collectionName, indexes] of Object.entries(definitions)) {
    const collection = db.collection(collectionName);
    for (const index of indexes) {
      try {
        await collection.createIndex(index.key, { name: index.name });
        result.created.push(`${collectionName}.${index.name}`);
      } catch (error) {
        // An existing index with the same name but a different key pattern
        // (IndexOptionsConflict / IndexKeySpecsConflict) means the schema
        // changed underneath us. Report it without aborting startup.
        result.failed.push({
          collection: collectionName,
          name: index.name,
          reason: error?.message || "Unknown index creation failure",
        });
      }
    }
  }

  return result;
}
