import pg from "pg";
import { config } from "./env.js";

/**
 * Specific's DATABASE_URL carries the routing and Reshape search-path options
 * required by its Postgres proxy. Passing pg's `options` setting separately
 * would replace those URL options and break pooled production connections.
 */
let poolPromise: Promise<pg.Pool> | null = null;

async function createPool(): Promise<pg.Pool> {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: 8,
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
