"use client";

import * as React from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

type ToastKind = "default" | "success" | "warning" | "error";

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string | undefined;
}

interface ToastCtx {
  toast: (t: Omit<ToastItem, "id">) => void;
}

const Ctx = React.createContext<ToastCtx | null>(null);

export function useToast(): ToastCtx {
  const c = React.useContext(Ctx);
  if (!c) throw new Error("useToast must be used inside ToastProvider");
  return c;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const toast = React.useCallback((t: Omit<ToastItem, "id">) => {
    setItems((cur) => [...cur, { ...t, id: Date.now() + Math.random() }]);
  }, []);
  return (
    <Ctx.Provider value={{ toast }}>
      <ToastPrimitive.Provider swipeDirection="right">
        {children}
        {items.map((t) => (
          <ToastPrimitive.Root
            key={t.id}
            duration={4500}
            onOpenChange={(open) => {
              if (!open) setItems((cur) => cur.filter((x) => x.id !== t.id));
            }}
            className={cn(
              // Northwind toast: white card, hairline border, soft shadow, tone dot.
              "group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-xl border bg-popover p-4 pr-8 text-popover-foreground shadow-[0_8px_30px_rgba(0,0,0,0.10)]",
              "data-[state=open]:animate-fade-in",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "mt-[5px] inline-block h-[7px] w-[7px] shrink-0 rounded-full",
                t.kind === "success" && "bg-success",
                t.kind === "warning" && "bg-warning-accent",
                t.kind === "error" && "bg-destructive",
                t.kind === "default" && "bg-foreground/30",
              )}
            />
            <div className="grid gap-1">
              <ToastPrimitive.Title className="text-[13px] font-semibold leading-snug">{t.title}</ToastPrimitive.Title>
              {t.description && (
                <ToastPrimitive.Description className="text-[12.5px] leading-normal text-muted-foreground">
                  {t.description}
                </ToastPrimitive.Description>
              )}
            </div>
            <ToastPrimitive.Close className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col-reverse gap-2 p-4 sm:bottom-4 sm:right-4 sm:max-w-sm" />
      </ToastPrimitive.Provider>
    </Ctx.Provider>
  );
}
