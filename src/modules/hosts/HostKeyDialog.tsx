import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ShieldCheckIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { scanKeys } from "./lib/hostStore";
import type { ScannedKey, SshHost } from "./lib/types";

type Props = {
  host: SshHost;
  onOpenChange: (open: boolean) => void;
  /** User accepted after seeing fingerprints: proceed to auth probe. */
  onAccept: () => void;
};

export function HostKeyDialog({ host, onOpenChange, onAccept }: Props) {
  const [keys, setKeys] = useState<ScannedKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setKeys(null);
    setError(null);
    void scanKeys(host.hostname, host.port).then(
      (found) => {
        if (!cancelled) setKeys(found);
      },
      (e) => {
        if (!cancelled) setError(String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [host]);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.75">
            <HugeiconsIcon icon={ShieldCheckIcon} size={16} strokeWidth={1.75} />
            Trust this host?
          </DialogTitle>
          <DialogDescription>
            {host.hostname} is not in your known_hosts. Verify the fingerprint
            out of band before continuing. Terax never skips this check.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-muted/40 p-2.5 font-mono text-[11px]">
          {keys === null && !error ? (
            <span className="text-muted-foreground">Scanning host keys...</span>
          ) : error ? (
            <span className="text-destructive">{error}</span>
          ) : keys && keys.length > 0 ? (
            keys.map((k) => (
              <div key={`${k.keyType}-${k.fingerprint}`} className="flex flex-col">
                <span className="text-foreground">{k.keyType}</span>
                <span className="break-all text-muted-foreground">
                  {k.fingerprint}
                </span>
              </div>
            ))
          ) : (
            <span className="text-muted-foreground">
              No keys returned. The host may be unreachable.
            </span>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={keys === null || keys.length === 0}
            onClick={() => {
              onOpenChange(false);
              onAccept();
            }}
          >
            I verified, continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
