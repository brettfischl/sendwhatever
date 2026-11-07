import type { SchemaTable } from '../admin/stats.js';
import { DEFAULT_ROW_LIMIT, MAX_ROW_LIMIT, isFilterable } from './rows.js';

/**
 * Builds a table's OpenAPI document from the live registry, so it can't drift from the schema.
 *
 * Table and column names come from client payloads. They only appear as encoded paths, property
 * keys and plain values, never in `description` (which Swagger UI renders as Markdown) or in
 * component names (which OpenAPI restricts).
 */

const COLUMN_SCHEMAS: Record<string, object> = {
  string: { type: ['string', 'null'] },
  number: { type: ['number', 'null'] },
  boolean: { type: ['boolean', 'null'] },
  timestamp: { type: ['string', 'null'], format: 'date-time' },
};

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const SHARED_ERRORS = {
  '401': errorResponse('The read-only API key is missing or invalid.'),
  '403': errorResponse('The account is not active.'),
  '404': errorResponse('The account or table does not exist.'),
  '503': errorResponse('Table data is unavailable. Try again.'),
};

export function buildTableSpec(table: SchemaTable, accountSlug: string) {
  const slugHeader = {
    name: 'X-Account-Slug',
    in: 'header',
    required: true,
    description: 'The account. In production the proxy sets this from the subdomain.',
    schema: { type: 'string', default: accountSlug },
  };
  const columns = table.columns.filter(({ name }) => !name.startsWith('_'));
  const properties = Object.fromEntries(
    columns.map(({ name, type }) => {
      // A `json` column can hold any value, which an empty schema allows.
      const schema = (Object.hasOwn(COLUMN_SCHEMAS, type) ? COLUMN_SCHEMAS[type] : {}) as object;
      const parent = table.parents.find((p) => `${p}_id` === name);
      return [name, parent ? { ...schema, 'x-references': parent } : schema];
    }),
  );
  const path = `/tables/${encodeURIComponent(table.name)}`;
  const filterParameters = columns
    .filter(({ name, type }) => isFilterable(name, type))
    .map(({ name }) => ({
      name,
      in: 'query',
      description: 'Returns rows where this column equals the value.',
      schema: properties[name],
    }));

  return {
    openapi: '3.1.0',
    info: {
      title: `Table: ${table.name}`,
      version: '1',
      description:
        'Generated from the live schema. Reads return live rows only: soft-deleted rows and platform columns are always left out. Requires a read-only API key from the Credentials page.',
    },
    servers: [{ url: '/' }],
    security: [{ readKey: [] }],
    paths: {
      [path]: {
        get: {
          operationId: 'listRows',
          summary: 'List rows, ordered by id',
          parameters: [
            slugHeader,
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: MAX_ROW_LIMIT, default: DEFAULT_ROW_LIMIT },
            },
            {
              name: 'after',
              in: 'query',
              description: 'Returns rows after this id. Pass `next_after` from the previous page.',
              schema: { type: 'string' },
            },
            ...filterParameters,
          ],
          responses: {
            '200': {
              description: 'One page of rows.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/RowPage' } } },
            },
            '400': errorResponse('A query parameter is not valid.'),
            ...SHARED_ERRORS,
          },
        },
      },
      [`${path}/{id}`]: {
        get: {
          operationId: 'getRow',
          summary: 'Get one row by id',
          parameters: [
            slugHeader,
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'The row.',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Row' } } },
            },
            '400': errorResponse('The id is not valid.'),
            ...SHARED_ERRORS,
            '404': errorResponse('The account, table, or row does not exist, or the row was deleted.'),
          },
        },
      },
    },
    components: {
      securitySchemes: { readKey: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Row: {
          type: 'object',
          required: ['id', ...columns.map(({ name }) => name)],
          properties: { id: { type: 'string' }, ...properties },
        },
        RowPage: {
          type: 'object',
          required: ['rows', 'next_after'],
          properties: {
            rows: { type: 'array', items: { $ref: '#/components/schemas/Row' } },
            next_after: {
              type: ['string', 'null'],
              description: 'The `after` value for the next page, or null on the last page.',
            },
          },
        },
        Error: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string' } },
        },
      },
    },
  };
}
