/**
 * Pure planning for CREATE-TABLE-only expand migrations.
 *
 * MySQL commits DDL statement by statement, so a three-table migration can be
 * partially present after a host failure. Planning per table makes a retry
 * create only what is missing instead of treating the first table as proof the
 * whole migration completed.
 */
export function createTableName(statement) {
  const match = statement.match(
    /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`([a-z0-9_]+)`/i,
  )
  return match?.[1] ?? null
}

export function planCreateTables(statements, existingTables) {
  const named = statements.map((statement) => ({
    statement,
    table: createTableName(statement),
  }))
  if (named.some((entry) => entry.table == null)) return null
  const names = named.map((entry) => entry.table)
  if (new Set(names).size !== names.length) {
    throw new Error('unexpected:duplicate-create-table')
  }
  const existing = new Set(existingTables)
  return {
    tables: names,
    missing: named.filter((entry) => !existing.has(entry.table)),
  }
}
