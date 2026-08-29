import pg from "pg";
import { config } from "./env.js";

/**
 * Reshape (Specific's migration tool) exposes in-progress migrations through a
 * versioned schema (e.g. migration_002_pipeline_extras). Detect the newest one
 * and put it first on the search_path so the app always sees the latest shape.
 */
let poolPromise: Promise<pg.Pool> | null = null;

async function createPool(): Promise<pg.Pool> {
  let searchPath = process.env.DATABASE_SEARCH_PATH ?? "";
  if (!searchPath) {
    const probe = new pg.Client({ connectionString: config.databaseUrl });
    await probe.connect();
    try {
      const r = await probe.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'migration_%' ORDER BY schema_name DESC LIMIT 1",
      );
      searchPath = r.rows[0] ? `${r.rows[0].schema_name},public` : "public";
    } finally {
      await probe.end();
    }
  }
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: 8,
    options: `-c search_path=${searchPath}`,
  });
}

export function getPool(): Promise<pg.Pool> {
  poolPromise ??= createPool();
  return poolPromise;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const pool = await getPool();
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T> {
  const rows = await query<T>(text, params);
  if (rows.length === 0) throw new Error(`query returned no rows: ${text.slice(0, 80)}`);
  return rows[0];
}

export async function maybeOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function digitsOnly(text: string): string {
  return text.replace(/\D/g, "");
}
