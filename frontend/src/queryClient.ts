import { QueryClient } from "@tanstack/react-query";

/**
 * Shared cache for API data.
 * - Revisiting a page shows cached data instantly, then refreshes in the background.
 * - Cached entries are dropped after 10 minutes unused, well before screenshot links (30 min) expire.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

export const keys = {
  users: ["users"] as const,
  user: (id: number) => ["users", id] as const,
  schedule: (id: number) => ["users", id, "schedule"] as const,
  dayData: (id: number, kind: string, day: string) => ["users", id, kind, day] as const,
  settings: ["settings"] as const,
  alerts: ["alerts"] as const,
  live: ["live"] as const,
  attendance: (day: string, userId?: number) => ["attendance", day, userId ?? "all"] as const,
  hours: (from: string, to: string) => ["hours", from, to] as const,
  myConfig: ["me", "config"] as const,
  myStats: ["me", "stats"] as const,
};
