export class ReviewRequestError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}
export async function reviewRequest<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store", signal,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new ReviewRequestError(result.error?.message ?? "The saved review could not be reached. Reconnect and try again.", result.error?.code ?? "provider_unavailable", response.status);
  return result as T;
}
export const reviewDate = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const claimValue = (value: string | number | boolean | null) => value === null ? "Unknown" : String(value);
