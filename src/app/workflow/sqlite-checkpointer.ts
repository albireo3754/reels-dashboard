import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * LangGraph's SqliteSaver over the built-in `node:sqlite` driver.
 *
 * `SqliteSaver.fromConnString` opens better-sqlite3, a native addon compiled for one
 * Node ABI. The desktop app embeds this server in Electron's main process, whose ABI
 * differs, so both the headless server and Electron use this adapter instead. The file
 * format is plain SQLite, so existing `checkpoints.sqlite` files keep working.
 * Only the better-sqlite3 surface SqliteSaver calls is provided.
 */
export function openNodeSqliteSaver(file: string): SqliteSaver {
  const db = new DatabaseSync(file);
  const bind = (args: unknown[]) =>
    args.map((value) => (value === undefined ? null : value)) as SQLInputValue[];
  const adapter = {
    pragma: (source: string) => db.exec(`PRAGMA ${source}`),
    exec: (sql: string) => {
      db.exec(sql);
      return adapter;
    },
    prepare: (sql: string) => {
      const statement = db.prepare(sql);
      return {
        get: (...args: unknown[]) => statement.get(...bind(args)),
        all: (...args: unknown[]) => statement.all(...bind(args)),
        run: (...args: unknown[]) => statement.run(...bind(args)),
      };
    },
    transaction:
      <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        db.exec("BEGIN");
        try {
          const result = fn(...args);
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    close: () => db.close(),
  };
  return new SqliteSaver(adapter as unknown as ConstructorParameters<typeof SqliteSaver>[0]);
}
