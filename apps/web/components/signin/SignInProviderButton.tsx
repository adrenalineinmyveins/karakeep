"use client";

import { Button } from "@/components/ui/button";
import { signIn } from "@/lib/auth/client";

export default function SignInProviderButton({
  provider,
  label,
  className,
}: {
  provider: {
    id: string;
    name: string;
  };
  // 自定义按钮文案（默认 "Sign in with {name}"）
  label?: string;
  className?: string;
}) {
  return (
    <Button
      onClick={() =>
        signIn(provider.id, {
          callbackUrl: "/",
        })
      }
      className={`w-full ${className ?? ""}`}
    >
      {label ?? `Sign in with ${provider.name}`}
    </Button>
  );
}
