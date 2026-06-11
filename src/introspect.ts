import postgres from "postgres";

export type Column = { name: string; type: string; pk: boolean; fk: string | null };
export type Table = { name: string; columns: Column[] };
export type Relation = { from_table: string; to_table: string; label: string | null };
export type Schema = { tables: Table[]; relations: Relation[] };

/**
 * Read the public-schema ER model from a live Postgres. Runs wherever the DB is
 * reachable (the customer's env / CI) — never PLMHub. Self-signed TLS is accepted
 * when the URL carries an sslmode (managed clusters); plain otherwise.
 */
export async function introspect(url: string): Promise<Schema> {
  const ssl = /sslmode=|[?&]ssl=/.test(url) ? ({ rejectUnauthorized: false } as const) : false;
  const sql = postgres(url, { ssl, max: 2, idle_timeout: 5, connect_timeout: 10 });
  try {
    const cols = await sql<
      { table_name: string; column_name: string; data_type: string }[]
    >`SELECT table_name, column_name, data_type
        FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`;

    const pks = await sql<{ table_name: string; column_name: string }[]>`
      SELECT kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'`;

    const fks = await sql<
      { table_name: string; column_name: string; ref_table: string }[]
    >`SELECT kcu.table_name, kcu.column_name, ccu.table_name AS ref_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`;

    const pkSet = new Set(pks.map((r) => `${r.table_name}.${r.column_name}`));
    const fkMap = new Map<string, string>();
    const relations: Relation[] = [];
    for (const r of fks) {
      fkMap.set(`${r.table_name}.${r.column_name}`, r.ref_table);
      relations.push({ from_table: r.table_name, to_table: r.ref_table, label: null });
    }

    const tables = new Map<string, Table>();
    for (const c of cols) {
      let t = tables.get(c.table_name);
      if (!t) {
        t = { name: c.table_name, columns: [] };
        tables.set(c.table_name, t);
      }
      t.columns.push({
        name: c.column_name,
        type: c.data_type,
        pk: pkSet.has(`${c.table_name}.${c.column_name}`),
        fk: fkMap.get(`${c.table_name}.${c.column_name}`) ?? null,
      });
    }

    return { tables: [...tables.values()], relations };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
