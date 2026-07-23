"use client";

import * as React from "react";
import { useRouter, useParams } from "next/navigation";
import {
  CommandRoot,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/toast";
import {
  Bot,
  Building2,
  FolderKanban,
  Boxes,
  KeyRound,
  Settings,
  SlidersHorizontal,
  ScrollText,
  Receipt,
  UserPlus,
  PlusCircle,
  LogOut,
  Users,
  Mail,
  Bell,
  Gauge,
  Globe,
  ShieldCheck,
  User2,
  Webhook,
  HardDrive,
  Activity,
  Plug,
  UsersRound,
  ListTodo,
  MessageSquare,
  Cloud,
  Database,
  type LucideIcon,
} from "lucide-react";
import {
  buildBaseCommands,
  composeCommands,
  groupCommands,
  type CommandContext,
  type CommandDescriptor,
} from "./command-registry";
import { recordRecentCommandId } from "@/lib/palette/entity-commands";

// Icon-name → component resolver. Keeps `command-registry.ts` pure (string
// names only) while the renderer owns the concrete icon set.
const ICONS: Record<string, LucideIcon> = {
  Bot,
  Building2,
  FolderKanban,
  Boxes,
  KeyRound,
  Settings,
  SlidersHorizontal,
  ScrollText,
  Receipt,
  UserPlus,
  PlusCircle,
  LogOut,
  Users,
  Mail,
  Bell,
  Gauge,
  Globe,
  ShieldCheck,
  User2,
  Webhook,
  HardDrive,
  Activity,
  Plug,
  UsersRound,
  ListTodo,
  MessageSquare,
  Cloud,
  Database,
};

// --- Registration context --------------------------------------------------
// Any page/product area can contribute extra descriptors for the lifetime of
// the component that registers them (registered on mount, removed on unmount).

interface PaletteCtxValue {
  open: () => void;
  /** IC7: true while the palette dialog is up — the entity source primes its
   *  lazy first-fetch and re-reads recents on the rising edge. */
  isOpen: boolean;
  register: (commands: CommandDescriptor[]) => () => void;
}
const PaletteCtx = React.createContext<PaletteCtxValue>({
  open: () => {},
  isOpen: false,
  register: () => () => {},
});

export function usePalette() {
  return React.useContext(PaletteCtx);
}

/**
 * Register palette commands for the lifetime of the calling component.
 * Example: `useRegisterCommands(useMemo(() => [...], [deps]))`.
 */
export function useRegisterCommands(commands: CommandDescriptor[]) {
  const { register } = usePalette();
  React.useEffect(() => register(commands), [register, commands]);
}

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const [extra, setExtra] = React.useState<CommandDescriptor[]>([]);
  const router = useRouter();
  const params = useParams<{ orgSlug?: string; projectSlug?: string }>();
  const { setToken, target, availableTargets, setTarget, isLocked } = useSession();
  const { toast } = useToast();

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []);

  const register = React.useCallback((commands: CommandDescriptor[]) => {
    setExtra((prev) => [...prev, ...commands]);
    return () => {
      setExtra((prev) => prev.filter((c) => !commands.includes(c)));
    };
  }, []);

  const ctx: CommandContext = React.useMemo(
    () => ({
      orgSlug: params?.orgSlug ?? null,
      projectSlug: params?.projectSlug ?? null,
      isLocked,
      targets: availableTargets.map((t) => ({ name: t.name })),
    }),
    [params?.orgSlug, params?.projectSlug, isLocked, availableTargets],
  );

  const groups = React.useMemo(
    () => groupCommands(composeCommands(buildBaseCommands(ctx), extra)),
    [ctx, extra],
  );

  const run = (cmd: CommandDescriptor) => {
    recordRecentCommandId(cmd.id); // IC7: entity-ish runs rank first next open
    setOpen(false);
    switch (cmd.kind) {
      case "navigate":
        router.push(cmd.to);
        break;
      case "action":
        if (cmd.actionId === "logout") {
          setToken(null);
          router.push("/login");
          toast({ kind: "success", title: "Logged out" });
        }
        break;
      case "target": {
        const t = availableTargets.find((x) => x.name === cmd.targetName);
        if (t) {
          setTarget(t);
          toast({ kind: "success", title: `Switched to ${t.name}` });
        }
        break;
      }
    }
  };

  return (
    <PaletteCtx.Provider value={{ open: () => setOpen(true), isOpen: open, register }}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl overflow-hidden rounded-[14px] p-0">
          <DialogTitle className="sr-only">Command palette</DialogTitle>
          <DialogDescription className="sr-only">
            Search and run actions, jump to pages, or switch scope.
          </DialogDescription>
          <CommandRoot>
            <CommandInput placeholder="Search actions, pages, scopes…" />
            <CommandList>
              <CommandEmpty>No matching commands.</CommandEmpty>
              {groups.map(({ group, items }) => (
                <CommandGroup
                  key={group}
                  heading={group === "Target" ? `Target (current: ${target.name})` : group}
                >
                  {items.map((cmd) => {
                    const Icon = cmd.icon ? ICONS[cmd.icon] : undefined;
                    return (
                      <CommandItem
                        key={cmd.id}
                        value={`${cmd.label} ${(cmd.keywords ?? []).join(" ")}`}
                        onSelect={() => run(cmd)}
                      >
                        {Icon ? <Icon className="h-[15px] w-[15px] text-muted-foreground" strokeWidth={1.8} /> : null}
                        {cmd.label}
                        {cmd.shortcut ? <CommandShortcut>{cmd.shortcut}</CommandShortcut> : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </CommandRoot>
        </DialogContent>
      </Dialog>
    </PaletteCtx.Provider>
  );
}
