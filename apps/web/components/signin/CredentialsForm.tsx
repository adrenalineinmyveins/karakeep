"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ActionButton } from "@/components/ui/action-button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { signIn } from "@/lib/auth/client";
import { useClientConfig } from "@/lib/clientConfig";
import { useTranslation } from "@/lib/i18n/client";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, Lock } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const VERIFY_EMAIL_ERROR = "Please verify your email address before signing in";

export default function CredentialsForm() {
  const [signinError, setSigninError] = useState("");
  const router = useRouter();
  const searchParams = useSearchParams();
  const clientConfig = useClientConfig();
  const { t } = useTranslation();

  const oAuthError = searchParams.get("error");
  if (oAuthError && !signinError) {
    setSigninError(t("signin.oauth_failed", { error: oAuthError }));
  }

  const form = useForm<z.infer<typeof signInSchema>>({
    resolver: zodResolver(signInSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  if (clientConfig.auth.disablePasswordAuth) {
    return (
      <div className="space-y-4">
        {signinError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>{signinError}</AlertTitle>
          </Alert>
        )}
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertTitle>{t("signin.password_auth_disabled")}</AlertTitle>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(async (value) => {
            const resp = await signIn("credentials", {
              redirect: false,
              email: value.email.trim(),
              password: value.password,
            });
            if (!resp || !resp?.ok || resp.error) {
              const signinFailed = t("signin.incorrect_credentials");
              if (resp?.error === "CredentialsSignin") {
                setSigninError(signinFailed);
              } else if (resp?.error === VERIFY_EMAIL_ERROR) {
                router.replace(
                  `/check-email?email=${encodeURIComponent(value.email.trim())}`,
                );
              } else {
                setSigninError(resp?.error ?? signinFailed);
              }
              return;
            }
            router.replace("/");
          })}
          className="space-y-4"
        >
          {signinError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{signinError}</AlertTitle>
            </Alert>
          )}

          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("signin.email")}</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    autoComplete="email"
                    spellCheck={false}
                    placeholder={t("signin.email_placeholder")}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("signin.password")}</FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    autoComplete="current-password"
                    placeholder={t("signin.password_placeholder")}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <ActionButton
            ignoreDemoMode
            type="submit"
            loading={form.formState.isSubmitting}
            className="w-full"
          >
            {t("signin.sign_in")}
          </ActionButton>

          <div className="text-center">
            <Link
              href="/forgot-password"
              className="text-sm text-muted-foreground underline hover:text-primary"
            >
              {t("signin.forgot_password_title")}
            </Link>
          </div>
        </form>
      </Form>

      <div className="text-center">
        <p className="text-sm text-gray-600">
          {t("signin.no_account")}{" "}
          <Link
            href="/signup"
            className="font-medium text-blue-600 hover:text-blue-500"
          >
            {t("signup.submit")}
          </Link>
        </p>
      </div>
    </div>
  );
}
