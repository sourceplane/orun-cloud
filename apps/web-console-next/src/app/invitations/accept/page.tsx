"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession, readStoredToken } from "@/lib/session";
import { wrap } from "@/lib/api";
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
    <div className="bg-grid-glow flex min-h-screen flex-col items-center bg-background px-5 pb-14 pt-[12vh]">
      <div className="w-full max-w-[400px] animate-fade-up">
        <div className="flex flex-col items-center gap-5 text-center">
          <OrunMark size={34} className="text-foreground" />
          <h1 className="font-serif text-[30px] font-medium leading-tight tracking-[-0.01em]">
            Workspace invitation
          </h1>
        </div>

        <div className="mt-7 rounded-xl border bg-card p-6">
          {state === "working" && (
            <div>
              <div className="flex items-center gap-2 text-[15px] font-semibold">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                Accepting your invitation…
              </div>
              <p className="mt-1.5 text-[12.5px] text-muted-foreground">This only takes a moment.</p>
            </div>
          )}

          {state === "success" && (
            <div>
              <div className="flex items-center gap-2 text-[15px] font-semibold text-success">
                <CheckCircle2 className="h-[18px] w-[18px]" strokeWidth={1.8} />
                Invitation accepted
              </div>
              <p className="mt-1.5 text-[12.5px] text-muted-foreground">
                You now have access. Taking you to your workspaces…
              </p>
              <div className="mt-5">
                <Button onClick={() => router.replace("/orgs")}>Go to your workspaces</Button>
              </div>
            </div>
          )}

          {state === "error" && (
            <div>
              <div className="flex items-center gap-2 text-[15px] font-semibold text-destructive">
                <XCircle className="h-[18px] w-[18px]" strokeWidth={1.8} />
                Couldn&apos;t accept the invitation
              </div>
              <p className="mt-1.5 text-[12.5px] leading-normal text-muted-foreground">{message}</p>
              <div className="mt-5 space-y-3">
                <Button onClick={() => router.replace("/orgs")}>View your workspaces</Button>
                <div>
                  <button
                    type="button"
                    className="text-[12px] text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                    onClick={() => {
                      setToken(null);
                      router.replace("/login");
                    }}
                  >
                    Signed in with the wrong account? Sign out
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
