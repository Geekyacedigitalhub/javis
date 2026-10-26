import postgres from "postgres";

/**
 * One process-wide PostgreSQL pool for every durable FROSH store.
 *
 * Render's free PostgreSQL instances have deliberately small connection
 * budgets. Giving every feature its own pool means a newly used feature can
 * wait forever for a database connection even though the database is healthy.
 * A shared pool bounds the entire API process to a predictable number of
 * connections and lets postgres.js queue short store queries safely.
 */
export type FroshDatabaseClient = ReturnType<typeof postgres>;

let client: FroshDatabaseClient | null | undefined;
let clientUrl: string | undefined;

export function getFroshDatabaseClient(): FroshDatabaseClient | null {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) return null;

  if (client) return client;

  clientUrl = url;
  client = postgres(url, {
    // Leave a connection available for Render/Postgres administration and use
    // one pool for the whole API process instead of one per product feature.
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
    // Database-side limits also cancel a blocked table lock/query. This is
    // important because an application Promise timeout cannot release a
    // database session that is still waiting for a lock.
    connection: {
      statement_timeout: 15_000,
      lock_timeout: 8_000,
      idle_in_transaction_session_timeout: 20_000,
    },
  });
  return client;
}

/** Close the shared pool once, when the API process itself is shutting down. */
export async function closeFroshDatabaseClient(): Promise<void> {
  const current = client;
  client = undefined;
  clientUrl = undefined;
  if (current) await current.end({ timeout: 5 });
}

/** Test-only visibility without exposing a connection string or credentials. */
export function hasFroshDatabaseClient(): boolean {
  return Boolean(client && clientUrl);
}
