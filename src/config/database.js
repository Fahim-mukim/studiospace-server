import { MongoClient } from "mongodb";

let client;
let database;
let connectionPromise;
let databaseConfigured = false;
let status = "not_configured";

export function getDatabaseStatus() {
  return status;
}

export function getDatabase() {
  return database;
}

export function getMongoClient() {
  return client;
}

export async function connectDatabase({ uri, databaseName }) {
  if (!uri) {
    databaseConfigured = false;
    status = "not_configured";
    return null;
  }

  databaseConfigured = true;
  if (status === "connected") return database;
  if (connectionPromise) return connectionPromise;

  status = "connecting";
  if (!client) {
    client = new MongoClient(uri);
    client.on("topologyDescriptionChanged", ({ newDescription }) => {
      if (newDescription.type === "Unknown") {
        if (status === "connected") status = "disconnected";
      } else if (status === "disconnected") {
        status = "connected";
      }
    });
  }

  connectionPromise = (async () => {
    try {
      await client.connect();
      const selectedDatabase = client.db(databaseName);
      await selectedDatabase.command({ ping: 1 });
      database = selectedDatabase;
      status = "connected";
      return database;
    } catch {
      status = "disconnected";
      throw new Error("MongoDB connection or ping failed.");
    } finally {
      connectionPromise = undefined;
    }
  })();

  return connectionPromise;
}

export async function closeDatabase() {
  if (connectionPromise) {
    try {
      await connectionPromise;
    } catch {
      status = "disconnected";
    }
  }

  const currentClient = client;
  if (!currentClient) {
    status = databaseConfigured ? "disconnected" : "not_configured";
    database = undefined;
    return;
  }

  await currentClient.close();
  client = undefined;
  database = undefined;
  status = databaseConfigured ? "disconnected" : "not_configured";
}
