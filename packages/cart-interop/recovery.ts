import type { CartCommand } from "./contracts";

// This journal contains the exact Sample command, never an integration credential.
// It is scoped to an opaque workspace identity and survives tab navigation/reload.
// A recorded command is only redispatched after the user chooses to recover it.
type JournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const key = (workspaceKey: string) => `worldkit.cart.pending.v1:${workspaceKey}`;
const kinds = new Set<CartCommand["kind"]>(["start_sample", "catalogue_add", "catalogue_change", "credential_issue", "credential_revoke", "cart_create", "cart_replace", "cart_approve", "cart_complete"]);

export function pendingCartCommand(storage: JournalStorage, workspaceKey: string): CartCommand | null {
  const raw = storage.getItem(key(workspaceKey));
  if (!raw) return null;
  if (raw.length > 100_000) throw new Error("The saved cart action could not be read. Keep this tab open and reload the saved workspace before continuing.");
  let value: { workspaceKey?: unknown; command?: Partial<CartCommand> };
  try { value = JSON.parse(raw); } catch { throw new Error("The saved cart action could not be decoded. Its outcome must be resolved before another action."); }
  const command = value?.command;
  if (!value || value.workspaceKey !== workspaceKey || !command || !kinds.has(command.kind!) || typeof command.requestId !== "string" || !/^[A-Za-z0-9:_-]{8,120}$/.test(command.requestId)) {
    throw new Error("The saved cart action is incomplete. Its outcome must be resolved before starting another action.");
  }
  return command as CartCommand;
}

export function recordPendingCartCommand(storage: JournalStorage, workspaceKey: string, command: CartCommand): void {
  const previous = pendingCartCommand(storage, workspaceKey);
  if (previous && JSON.stringify(previous) !== JSON.stringify(command)) throw new Error("Recover the earlier saved action before starting a new one.");
  const value = JSON.stringify({ workspaceKey, command });
  storage.setItem(key(workspaceKey), value);
  if (storage.getItem(key(workspaceKey)) !== value) throw new Error("The browser could not retain this action for safe recovery. No request was sent.");
}

export function clearPendingCartCommand(storage: JournalStorage, workspaceKey: string, command: CartCommand): void {
  const previous = pendingCartCommand(storage, workspaceKey);
  if (previous && JSON.stringify(previous) === JSON.stringify(command)) storage.removeItem(key(workspaceKey));
}
