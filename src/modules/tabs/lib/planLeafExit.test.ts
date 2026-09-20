import { describe, expect, it } from "vitest";
import { planLeafExit } from "./planLeafExit";

const local = { kind: "local" } as const;
const ssh = { kind: "ssh", hostId: "h1" } as const;
const wsl = { kind: "wsl", distro: "Ubuntu" } as const;
const zellij = { hostId: "h1", session: "dev" };
const dockerExec = { hostId: "h1", container: "c", shell: "sh", attach: false };

describe("planLeafExit", () => {
  it("closes the pane for local and WSL shells regardless of code", () => {
    expect(planLeafExit({ env: local }, 0)).toBe("close");
    expect(planLeafExit({ env: local }, 130)).toBe("close");
    expect(planLeafExit({ env: wsl }, 1)).toBe("close");
  });

  it("keeps plain SSH and docker exec tabs for reconnect on any exit", () => {
    expect(planLeafExit({ env: ssh }, 0)).toBe("reconnect");
    expect(planLeafExit({ env: ssh }, 255)).toBe("reconnect");
    expect(planLeafExit({ env: ssh, dockerExec }, 0)).toBe("reconnect");
    expect(planLeafExit({ env: ssh, dockerExec }, 130)).toBe("reconnect");
  });

  it("closes a zellij tab on a clean detach and reconnects otherwise", () => {
    expect(planLeafExit({ env: ssh, zellijAttach: zellij }, 0)).toBe("close");
    expect(planLeafExit({ env: ssh, zellijAttach: zellij }, 1)).toBe("reconnect");
    expect(planLeafExit({ env: ssh, zellijAttach: zellij }, 255)).toBe(
      "reconnect",
    );
  });
});
