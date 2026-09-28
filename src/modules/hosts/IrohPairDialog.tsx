import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ZapIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { confirmIrohPin, setupIrohHost } from "./lib/hostStore";
import type { IrohBootstrapResult, SshHost } from "./lib/types";

type Props = {
  host: SshHost;
  onOpenChange: (open: boolean) => void;
  onEnabled: (endpointId: string) => void;
};

/** Pairing dialog for the iroh P2P fallback transport: drives
 *  `iroh_setup_host` over the already-open SSH channel to arm the fallback
 *  daemon, shows the host's iroh identity fingerprint for confirmation
 *  (mirrors `HostKeyDialog`'s SSH host-key TOFU flow), then writes the pin
 *  via `iroh_confirm_pin` only after explicit confirmation. */
export function IrohPairDialog({ host, onOpenChange, onEnabled }: Props) {
  const [result, setResult] = useState<IrohBootstrapResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    void setupIrohHost(host.id).then(
      (r) => {
        if (!cancelled) setResult(r);
      },
      (e) => {
        if (!cancelled) setError(String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [host.id]);

  const confirm = async () => {
    if (!result) return;
    setConfirming(true);
    try {
      await confirmIrohPin(host.id, result.endpointId);
      onOpenChange(false);
      onEnabled(result.endpointId);
    } catch (e) {
      setError(String(e));
      setConfirming(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.75">
            <HugeiconsIcon icon={ZapIcon} size={16} strokeWidth={1.75} />
            Enable P2P fallback for {host.alias}?
          </DialogTitle>
          <DialogDescription>
            Terax reaches this host over SSH as usual. This adds a peer-to-peer
            fallback (via iroh) that keeps working if SSH becomes unreachable
            while the host stays online. Verify the identity below before
            trusting it - Terax never skips this check.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-muted/40 p-2.5 font-mono text-[11px]">
          {result === null && !error ? (
            <span className="text-muted-foreground">
              Arming fallback over SSH...
            </span>
          ) : error ? (
            <span className="text-destructive">{error}</span>
          ) : result ? (
            <div className="flex flex-col">
              <span className="text-foreground">iroh endpoint id</span>
              <span className="break-all text-muted-foreground">
                {result.fingerprint}...
              </span>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!result || confirming}
            onClick={() => void confirm()}
          >
            {confirming ? "Enabling..." : "Trust and enable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
