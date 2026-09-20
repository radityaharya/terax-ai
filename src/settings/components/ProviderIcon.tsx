import { PlugIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  size?: number;
  className?: string;
};

export function ProviderIcon({ size = 14, className }: Props) {
  return (
    <HugeiconsIcon
      icon={PlugIcon}
      size={size}
      strokeWidth={1.75}
      className={className}
    />
  );
}
