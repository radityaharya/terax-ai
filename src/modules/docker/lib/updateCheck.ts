import { sshRpc } from "@/modules/ai/lib/native";

export type ImageUpdate = {
  reference: string;
  localDigest: string;
  updateAvailable: boolean;
};

/** Ask the agent whether the registry has a newer digest for a reference. */
export async function checkImageUpdate(
  hostId: string,
  reference: string,
): Promise<ImageUpdate> {
  return sshRpc<ImageUpdate>(
    "docker_image_update_check",
    { reference },
    hostId,
  );
}
