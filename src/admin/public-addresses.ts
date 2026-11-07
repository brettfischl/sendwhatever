import type { Config } from '../config.js';

/**
 * What admin pages show customers (§21.3). Unset settings fall back to local mode. Only the display
 * changes: a store's own `connection` stays on localhost, because that's how the services reach Postgres.
 */

export function ingestEndpoint(config: Pick<Config, 'publicBaseUrl' | 'port'>): string {
  return `${config.publicBaseUrl ?? `http://localhost:${config.port}`}/ingest`;
}

export interface PublicDbAddress {
  host: string;
  port: number;
  /** True when PUBLIC_DB_HOST is set: connection strings then end in `?sslmode=require`. */
  requireSsl: boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * The address customers use for a store whose own connection is `store`. A store on the local data
 * server gets the public address; an external store keeps its own host and port.
 */
export function publicDbAddress(
  config: Pick<Config, 'publicDbHost' | 'publicDbPort' | 'postgresPort'>,
  store: { host: unknown; port: unknown },
): PublicDbAddress {
  if (typeof store.host === 'string' && !LOCAL_HOSTS.has(store.host)) {
    return { host: store.host, port: Number(store.port), requireSsl: false };
  }
  return {
    host: config.publicDbHost ?? 'localhost',
    port: config.publicDbPort ?? config.postgresPort,
    requireSsl: config.publicDbHost !== undefined,
  };
}
