"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useSession, readStoredToken } from "@/lib/session";
import { wrap } from "@/lib/api";
import { CONSOLE_TITLE } from "@/lib/app-config";
import { OrunMark } from "@/components/brand/logo";

/**
 * Invitation accept landing (auto-accept after sign-in). Reached from the
 * one-click "Accept invitation" button in the invitation email:
 * `/invitations/accept?inv=inv_…`. If the recipient isn't signed in we bounce
 * to /login with a `returnTo` back here; once authenticated we accept the
 * invitation via the email-matched `POST /v1/me/invitations/:id/accept` path
 * (no token) and forward into their workspaces. Lives outside the app shell so
 * it controls its own auth handling and preserves the deep link.
 */
export default function AcceptInvitationPage() {
  const router = useRouter();
  const { client, setToken } = useSession();
  const [state, setState] = React.useState<"working" | "success" | "error">("working");
  const [message, setMessage] = React.useState<string>("");
  const ranRef = React.useRef(false);

  React.useEffect(() => {
    // Accept is a one-shot side effect; guard against React's double-invoke.
    if (ranRef.current) return;
    ranRef.current = true;

    const inv = new URLSearchParams(window.location.search).get("inv");
    if (!inv) {
      setState("error");
      setMessage("This link is missing its invitation reference. Open your workspaces to view pending invitations.");
      return;
    }

    // Not signed in yet → sign in first, then return here to auto-accept.
    if (!readStoredToken()) {
      const returnTo = `/invitations/accept?inv=${encodeURIComponent(inv)}`;
      router.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }

    void (async () => {
      const r = await wrap(() => client.memberships.acceptMyInvitation(inv));
      if (r.ok) {
        setState("success");
        return;
      }
      setState("error");
      setMessage(
        r.error.message ||
          "We couldn't accept this invitation. It may have expired, been revoked, or been sent to a different email address.",
      );
    })();
  }, [client, router]);

  // On success, drop the user into their workspaces (the accepted one is now
  // listed) after a short beat so they can read the confirmation.
  React.useEffect(() => {
    if (state !== "success") return;
    const t = setTimeout(() => router.replace("/orgs"), 1600);
    return () => clearTimeout(t);
  }, [state, router]);

  return (
    <div className="bg-grid-glow grid min-h-screen place-items-center bg-background px-4">
      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center gap-3">
          <OrunMark size={34} className="text-foreground" />
          <div className="text-base font-semibold tracking-tight">{CONSOLE_TITLE}</div>
        </div>

        <Card className="animate-fade-in">
          {state === "working" && (
            <>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Accepting your invitation…
                </CardTitle>
                <CardDescription>This only takes a moment.</CardDescription>
              </CardHeader>
            </>
          )}

          {state === "success" && (
            <>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-success">
                  <CheckCircle2 className="h-5 w-5" />
                  Invitation accepted
                </CardTitle>
                <CardDescription>
                  You now have access. Taking you to your workspaces…
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button onClick={() => router.replace("/orgs")}>Go to your workspaces</Button>
              </CardContent>
            </>
          )}

          {state === "error" && (
            <>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-destructive">
                  <XCircle className="h-5 w-5" />
                  Couldn&apos;t accept the invitation
                </CardTitle>
                <CardDescription>{message}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button onClick={() => router.replace("/orgs")}>View your workspaces</Button>
                <div>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline underline-offset-2"
                    onClick={() => {
                      setToken(null);
                      router.replace("/login");
                    }}
                  >
                    Signed in with the wrong account? Sign out
                  </button>
                </div>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
