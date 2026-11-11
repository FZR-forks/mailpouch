/**
 * Production counterpart of the E2E mailbox identity proof. A label-scoped
 * mutation runs inside `withMailboxScopes`; every IMAP mutation re-checks,
 * while it holds the mailbox lock, that the selected mailbox is the authorized
 * generation and that each UID operand was authorized for it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface AuthorizedMailboxScope {
  folder: string;
  uidValidity: bigint;
  uids: readonly string[];
}

const scopes = new AsyncLocalStorage<ReadonlyMap<string, AuthorizedMailboxScope>>();

/** Run `operation` with mutations restricted to the given source-mailbox UID sets. */
export function withMailboxScopes<T>(authorized: Iterable<AuthorizedMailboxScope>, operation: () => Promise<T>): Promise<T> {
  return scopes.run(new Map([...authorized].map(scope => [scope.folder, scope])), operation);
}

/** Run backend-owned follow-up work (not agent-selected UIDs) outside any scoped-mutation context. */
export function withoutMailboxScopes<T>(operation: () => Promise<T>): Promise<T> {
  return scopes.exit(operation);
}

/** Fail closed when a scoped mutation touches another mailbox, generation, or UID. */
export function assertScopedMailbox(
  folder: string,
  uids: readonly string[],
  mailbox: false | { path?: string; uidValidity?: bigint | number | string } | null | undefined,
): void {
  const authorized = scopes.getStore();
  if (!authorized) return;
  const scope = authorized.get(folder);
  const selected = mailbox && typeof mailbox === "object" ? mailbox : undefined;
  const allowed = scope ? new Set(scope.uids) : undefined;
  if (!scope || !selected || (selected.path !== undefined && selected.path !== folder)
      || selected.uidValidity === undefined || BigInt(selected.uidValidity) !== scope.uidValidity
      || uids.some(uid => !allowed!.has(uid))) {
    throw new Error("Mailbox changed during the request; retry the operation");
  }
}
