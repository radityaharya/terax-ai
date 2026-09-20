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
import { ServerStack03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { HostColorPicker } from "./HostColorPicker";
import { hostIdSeed, suggestHostColor } from "./lib/hostColor";
import { saveHost } from "./lib/hostStore";
import type { SshHost, SshHostInput } from "./lib/types";

type Props = {
  host: SshHost | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (host: SshHost) => void;
};

export function HostEditorDialog({ host, onOpenChange, onSaved }: Props) {
  const [alias, setAlias] = useState(host?.alias ?? "");
  const [user, setUser] = useState(host?.user ?? "");
  const [hostname, setHostname] = useState(host?.hostname ?? "");
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [identityFile, setIdentityFile] = useState(host?.identityFile ?? "");
  const [remoteRoot, setRemoteRoot] = useState(host?.remoteRoot ?? "");
  const [color, setColor] = useState<string | null>(host?.color ?? null);
  const [agentForward, setAgentForward] = useState(host?.agentForward ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAlias(host?.alias ?? "");
    setUser(host?.user ?? "");
    setHostname(host?.hostname ?? "");
    setPort(String(host?.port ?? 22));
    setIdentityFile(host?.identityFile ?? "");
    setRemoteRoot(host?.remoteRoot ?? "");
    setColor(host?.color ?? null);
    setAgentForward(host?.agentForward ?? false);
    setError(null);
    setSaving(false);
  }, [host]);

  // What "Auto" resolves to: the real id once saved, else the id the backend
  // will mint from this alias — so the preview matches the saved host.
  const autoHex = suggestHostColor(host?.id || hostIdSeed(alias));

  const submit = async () => {
    const portNum = Number.parseInt(port.trim(), 10);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setError("Port must be 1-65535");
      return;
    }
    setSaving(true);
    setError(null);
    const input: SshHostInput = {
      id: host?.id ?? null,
      alias: alias.trim(),
      user: user.trim(),
      hostname: hostname.trim(),
      port: portNum,
      identityFile: identityFile.trim() || null,
      remoteRoot: remoteRoot.trim() || null,
      color,
      agentForward,
    };
    try {
      const saved = await saveHost(input);
      onSaved(saved);
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.75">
            <HugeiconsIcon icon={ServerStack03Icon} size={16} strokeWidth={1.75} />
            {host ? "Edit host" : "Add SSH host"}
          </DialogTitle>
          <DialogDescription>
            Connection details only. Passwords and key passphrases stay in the
            OS keychain, never in this form.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field label="Alias" hint="Shown in the Hosts panel and tabs">
            <Input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="prod-web"
            />
          </Field>
          <Field
            label="Color"
            hint="Tints this host in the Hosts panel and on its tabs."
          >
            <HostColorPicker
              value={color}
              autoHex={autoHex}
              previewLabel={alias.trim() || hostname.trim() || "host"}
              onChange={setColor}
            />
          </Field>
          <div className="grid grid-cols-[1fr_5.5rem] gap-2">
            <Field label="User">
              <Input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="deploy"
              />
            </Field>
            <Field label="Port">
              <Input
                value={port}
                inputMode="numeric"
                onChange={(e) => setPort(e.target.value)}
                placeholder="22"
              />
            </Field>
          </div>
          <Field label="Hostname" hint="IP or DNS name, never a full ssh command">
            <Input
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="10.0.0.5"
            />
          </Field>
          <Field label="Identity file (optional)" hint="~/.ssh/id_ed25519">
            <Input
              value={identityFile}
              onChange={(e) => setIdentityFile(e.target.value)}
              placeholder="~/.ssh/id_ed25519"
            />
          </Field>
          <Field label="Remote root (optional)" hint="Defaults to the remote home">
            <Input
              value={remoteRoot}
              onChange={(e) => setRemoteRoot(e.target.value)}
              placeholder="/srv/app"
            />
          </Field>
          <label className="flex cursor-pointer items-start gap-2 text-xs">
            <input
              type="checkbox"
              checked={agentForward}
              onChange={(e) => setAgentForward(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">Forward local SSH agent</span>
              <span className="block text-muted-foreground">
                Needed for git-over-SSH on the remote. Exposes your keys to the
                remote while connected.
              </span>
            </span>
          </label>
          {error && <div className="text-xs text-destructive">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {saving ? "Saving..." : host ? "Save" : "Add host"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 text-xs">
      <Label className="text-[11px] font-medium">{label}</Label>
      {children}
      {hint && <span className="text-muted-foreground">{hint}</span>}
    </div>
  );
}
