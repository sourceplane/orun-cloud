"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { SessionProvider, useSession } from "@/lib/session";
import { createPersistOptions, clearPersistedQueryCache } from "@/lib/query-persist";
import { ToastProvider } from "@/components/ui/toast";
import { CommandPaletteProvider } from "@/components/shell/command-palette";
import { TooltipProvider } from "@/components/ui/tooltip";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Stale-while-revalidate: cached data paints instantly on navigation
        // and revalidates in the background. gcTime keeps it around between
        // visits. Conservative focus refetch to avoid surprise spinners.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });
}

/**
 * Clear the query cache when the auth token changes (login/logout/token swap)
 * so a new identity never reads the previous one's cached data. IC3: also
 * wipes the persisted (IndexedDB) copy — the persister buster already refuses
 * to restore across an epoch change; this removes the stale bytes too.
 */
function CacheResetOnAuthChange({ queryClient }: { queryClient: QueryClient }) {
  const { token } = useSession();
  const prev = React.useRef(token);
  React.useEffect(() => {
    if (prev.current !== token) {
      prev.current = token;
      queryClient.clear();
      clearPersistedQueryCache();
    }
  }, [token, queryClient]);
  return null;
}

/**
 * Query-cache provider with persistence (IC3): revisits restore the previous
 * session's cache from IndexedDB (keyed to target+token epoch, 24h cap,
 * secrets exempt — see query-persist.ts) and revalidate in background, so a
 * returning user paints real data instead of skeletons. Needs the session
 * (target + token) to compute the epoch, hence mounted inside SessionProvider
 * — the session itself never reads queries.
 */
function PersistedQueryProvider({ children }: { children: React.ReactNode }) {
  // One QueryClient for the app lifetime (survives re-renders, not re-created).
  const [queryClient] = React.useState(makeQueryClient);
  const { target, token } = useSession();
  const persistOptions = React.useMemo(
    () => createPersistOptions(target.name, token),
    [target.name, token],
  );
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <CacheResetOnAuthChange queryClient={queryClient} />
      {children}
    </PersistQueryClientProvider>
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    // Northwind is a light-first design; dark remains an explicit opt-in.
    <NextThemesProvider attribute="class" defaultTheme="light" enableSystem={false}>
      <SessionProvider>
        <PersistedQueryProvider>
          <ToastProvider>
            <TooltipProvider delayDuration={200}>
              <CommandPaletteProvider>{children}</CommandPaletteProvider>
            </TooltipProvider>
          </ToastProvider>
        </PersistedQueryProvider>
      </SessionProvider>
    </NextThemesProvider>
  );
}
