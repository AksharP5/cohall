import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite"

interface RunResult {
  readonly changes: number
}

class Statement<Row, Parameters extends Array<SQLInputValue>> {
  readonly #statement: StatementSync

  constructor(statement: StatementSync) {
    this.#statement = statement
  }

  get(...parameters: Parameters): Row | null {
    const row = this.#statement.get(...parameters)
    return row === undefined ? null : (row as unknown as Row)
  }

  all(...parameters: Parameters): ReadonlyArray<Row> {
    return this.#statement.all(...parameters) as unknown as ReadonlyArray<Row>
  }

  run(...parameters: Parameters): RunResult {
    const result = this.#statement.run(...parameters)
    return { changes: Number(result.changes) }
  }
}

export class Database {
  readonly #database: DatabaseSync

  constructor(path: string) {
    this.#database = new DatabaseSync(path)
  }

  query<
    Row = Record<string, unknown>,
    Parameters extends Array<SQLInputValue> = Array<SQLInputValue>,
  >(sql: string): Statement<Row, Parameters> {
    return new Statement(this.#database.prepare(sql))
  }

  exec(sql: string): void {
    this.#database.exec(sql)
  }

  transaction<Result>(operation: () => Result): () => Result {
    return () => {
      this.#database.exec("BEGIN IMMEDIATE")
      try {
        const result = operation()
        this.#database.exec("COMMIT")
        return result
      } catch (cause) {
        this.#database.exec("ROLLBACK")
        throw cause
      }
    }
  }

  close(): void {
    this.#database.close()
  }
}
