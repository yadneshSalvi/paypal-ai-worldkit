import { initialize, closeDatabase } from "../src/server/db";
await initialize();
console.log(JSON.stringify({ database: "worldkit", schema: "ready", credentials: "not displayed" }));
await closeDatabase();
