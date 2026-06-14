"use client";

import * as React from "react";
import { Terminal, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";

/**
 * Device-flow verification page (saas-orun-platform OP1, RFC-8628 §3.3).
 *
 * Headless CLIs print a short user code and this URL. The signed-in user enters
 * the code here; approving it lets the polling CLI exchange its device code for
 * a session. This is the human half of `orun auth login --device`.
 */
export default function CliDevicePage() {
  const { client } = useSession();
  const { toast } = useToast();
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [approved, setApproved] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    setBusy(true);
    const r = await wrap(() => client.cliSessions.approveByUserCode(trimmed));
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not approve", description: r.error.message });
      return;
    }
    setApproved(true);
  };

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4 px-4 py-12">
      <Card>
        <CardHeader className="space-y-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Terminal className="h-5 w-5" />
            <span className="text-sm font-medium">Orun CLI</span>
          </div>
          <CardTitle className="text-xl">Connect a device</CardTitle>
          <CardDescription>
            Enter the code shown in your terminal to authorize the Orun CLI on that device.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {approved ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted p-3 text-sm">
              <ShieldCheck className="h-5 w-5 text-emerald-500" />
              Device approved. Return to your terminal — it should finish signing in shortly.
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="user-code">Device code</Label>
                <Input
                  id="user-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="BCDF-GHJK"
                  autoComplete="off"
                  autoCapitalize="characters"
                  className="font-mono tracking-widest"
                />
              </div>
              <Button type="submit" loading={busy} disabled={!code.trim()} className="w-full">
                Approve device
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
