import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { BackgroundCheckpoint, BackgroundStore } from "../../packages/spec-evidence/providers";

/** Private CLI checkpoint store. One evaluation worker owns each operation. */
export class FileModelStore implements BackgroundStore {
  constructor(private path: string) {}
  async reserve(initial: BackgroundCheckpoint) {
    await mkdir(dirname(this.path), { recursive: true });
    try { await writeFile(this.path, JSON.stringify(initial, null, 2) + "\n", { mode: 0o600, flag: "wx" }); return { created: true, checkpoint: initial }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; return { created: false, checkpoint: JSON.parse(await readFile(this.path, "utf8")) as BackgroundCheckpoint }; }
  }
  async save(checkpoint: BackgroundCheckpoint) {
    const current = JSON.parse(await readFile(this.path, "utf8")) as BackgroundCheckpoint;
    if (current.operationId !== checkpoint.operationId || current.requestHash !== checkpoint.requestHash) throw new Error("Model checkpoint binding changed.");
    if (["received", "failed"].includes(current.phase) && !["received", "failed"].includes(checkpoint.phase)) return;
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(checkpoint, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, this.path);
  }
}
