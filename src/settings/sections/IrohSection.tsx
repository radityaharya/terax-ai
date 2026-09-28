import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  clearIrohApiKey,
  getIrohConfig,
  setIrohApiKey,
  setIrohRelayUrls,
} from "@/modules/hosts/lib/irohConfig";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";

/**
 * Global transport settings for the iroh P2P fallback. Empty config means
 * the zero-config default (n0 public relays). Custom relay URLs give a
 * fully self-hosted, n0-independent deployment; the n0 API key switches to
 * authenticated n0 shared/dedicated relays. Both are optional and apply to
 * every host on the next pairing/bootstrap.
 */
export function IrohSection() {
  const [relayText, setRelayText] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeySet, setApiKeySet] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"relays" | "key" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getIrohConfig().then(
      (cfg) => {
        if (cancelled) return;
        setRelayText(cfg.relayUrls.join("\n"));
        setApiKeySet(cfg.apiKeySet);
        setLoading(false);
      },
      (e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const saveRelays = async () => {
    setBusy("relays");
    setError(null);
    setNote(null);
    try {
      const urls = relayText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      await setIrohRelayUrls(urls);
      setNote(
        urls.length === 0
          ? "Relay list cleared. Using the default n0 relays."
          : `Saved ${urls.length} relay${urls.length === 1 ? "" : "s"}. Re-pair hosts to apply.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const saveKey = async () => {
    setBusy("key");
    setError(null);
    setNote(null);
    try {
      await setIrohApiKey(apiKeyInput);
      setApiKeySet(apiKeyInput.trim().length > 0);
      setApiKeyInput("");
      setNote(
        "API key saved to the OS keychain. Re-pair hosts to apply it to them.",
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const clearKey = async () => {
    setBusy("clear");
    setError(null);
    setNote(null);
    try {
      await clearIrohApiKey();
      setApiKeySet(false);
      setNote("API key cleared.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <SectionHeader
        title="Iroh"
        description="Peer-to-peer fallback transport for SSH hosts. Optional: with nothing set here, Terax uses n0's public relays."
      />

      <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-3">
        <span className="text-[12.5px] font-medium">Relay endpoints</span>
        <span className="text-[10.5px] leading-relaxed text-muted-foreground">
          One URL per line. Empty uses the default n0 relays. Set these to your
          own (self-hosted) relay to run without any n0 dependency. Requires an
          open SSH connection to each host to apply.
        </span>
        <Textarea
          value={relayText}
          onChange={(e) => setRelayText(e.target.value)}
          placeholder={"https://relay.example.com"}
          spellCheck={false}
          disabled={loading}
          className="min-h-20 font-mono text-[11.5px]"
        />
        <div>
          <Button
            size="sm"
            className="h-7 text-[11.5px]"
            disabled={loading || busy !== null}
            onClick={() => void saveRelays()}
          >
            {busy === "relays" ? "Saving..." : "Save relays"}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-3">
        <span className="flex items-center gap-2 text-[12.5px] font-medium">
          n0 Iroh Services API key
          <span
            className={
              apiKeySet
                ? "rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-500"
                : "rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            }
          >
            {apiKeySet ? "Set" : "Not set"}
          </span>
        </span>
        <span className="text-[10.5px] leading-relaxed text-muted-foreground">
          Uses n0's authenticated shared/dedicated relays. Stored in the OS
          keychain and used locally to mint an endpoint-bound relay token; the
          key itself never leaves this machine.
        </span>
        <Input
          type="password"
          value={apiKeyInput}
          onChange={(e) => setApiKeyInput(e.target.value)}
          placeholder="Paste a project API key"
          spellCheck={false}
          disabled={loading}
          className="h-8 font-mono text-[11.5px]"
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="h-7 text-[11.5px]"
            disabled={
              loading || busy !== null || apiKeyInput.trim().length === 0
            }
            onClick={() => void saveKey()}
          >
            {busy === "key" ? "Saving..." : "Save key"}
          </Button>
          {apiKeySet && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11.5px] text-destructive"
              disabled={loading || busy !== null}
              onClick={() => void clearKey()}
            >
              {busy === "clear" ? "Clearing..." : "Clear"}
            </Button>
          )}
        </div>
      </div>

      {error && <div className="text-[11px] text-destructive">{error}</div>}
      {note && <div className="text-[11px] text-muted-foreground">{note}</div>}
    </div>
  );
}
