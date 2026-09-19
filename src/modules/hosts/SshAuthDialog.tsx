import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Key01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { SshHost } from "./lib/types";

export type SshAuthChoice =
  | { kind: "terminal-2fa" }
  | { kind: "open-terminal" };

type Props = {
  host: SshHost;
  /** Suggested step from the probe: key | password | terminal-2fa */
  next: string;
  message: string;
  onOpenChange: (open: boolean) => void;
  onChoice: (choice: SshAuthChoice) => void;
};

export function SshAuthDialog({
  host,
  next,
  message,
  onOpenChange,
  onChoice,
}: Props) {
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  void password;
  void remember;
  void setRemember;

  const is2fa = next === "terminal-2fa";

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.75">
            <HugeiconsIcon icon={Key01Icon} size={16} strokeWidth={1.75} />
            Authenticate to {host.alias}
          </DialogTitle>
          <DialogDescription>{message}</DialogDescription>
        </DialogHeader>
        {is2fa ? (
          <div className="rounded-md border border-border/60 bg-muted/40 p-2.5 text-xs text-muted-foreground">
            This host needs an interactive step (password plus a second factor
            or push approval). Terax opens a terminal tab where you complete it
            directly, then the connection continues automatically.
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border border-border/60 bg-muted/40 p-2.5 text-xs text-muted-foreground">
              Password entry is not wired yet in this build. Use the terminal
              to authenticate once; the shared connection then serves files and
              git without re-prompting.
            </div>
            <span className="flex flex-col gap-1 text-xs">
              <Label className="text-[11px] font-medium">
                Password (kept in memory only, for the terminal)
              </Label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Not stored"
                disabled
              />
            </span>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {is2fa ? (
            <Button
              onClick={() => {
                onOpenChange(false);
                onChoice({ kind: "terminal-2fa" });
              }}
            >
              Authenticate in terminal
            </Button>
          ) : (
            <Button
              onClick={() => {
                onOpenChange(false);
                onChoice({ kind: "open-terminal" });
              }}
            >
              Open terminal to connect
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
