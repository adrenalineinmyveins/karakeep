"use client";

import type { TurnstileInstance } from "@marsidev/react-turnstile";
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ActionButton } from "@/components/ui/action-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Turnstile } from "@marsidev/react-turnstile";
import { useMutation } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { AlertCircle, UserX } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { useTRPC } from "@saiye/shared-react/trpc";
import { zSignUpSchema } from "@saiye/shared/types/users";
import { isMobileAppRedirect } from "@saiye/shared/utils/redirectUrl";

const VERIFY_EMAIL_ERROR = "Please verify your email address before signing in";

interface SignUpFormProps {
  redirectUrl: string;
}

export default function SignUpForm({ redirectUrl }: SignUpFormProps) {
  const api = useTRPC();
  const { t } = useTranslation();
  const form = useForm<z.infer<typeof zSignUpSchema>>({
    resolver: zodResolver(zSignUpSchema),
    defaultValues: {
      email: "",
      name: "",
      password: "",
      confirmPassword: "",
      turnstileToken: "",
    },
  });
  const [errorMessage, setErrorMessage] = useState("");
  const router = useRouter();
  const clientConfig = useClientConfig();
  const turnstileSiteKey = clientConfig.turnstile?.siteKey;
  const turnstileRef = useRef<TurnstileInstance>(null);

  const createUserMutation = useMutation(api.users.create.mutationOptions());

  if (
    clientConfig.auth.disableSignups ||
    clientConfig.auth.disablePasswordAuth
  ) {
    return (
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">
            {t("signup.sign_up_unavailable")}
          </CardTitle>
          <CardDescription>{t("signup.registration_disabled")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <Alert>
              <UserX className="h-4 w-4" />
              <AlertDescription>
                {t("signup.signups_disabled_description")}
              </AlertDescription>
            </Alert>
            <Button asChild className="w-full">
              <Link href="/signin">{t("signin.back_to_signin")}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl font-bold">
          {t("signup.title")}
        </CardTitle>
        <CardDescription>{t("signup.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(async (value) => {
              if (turnstileSiteKey && !value.turnstileToken) {
                form.setError("turnstileToken", {
                  type: "manual",
                  message: t("signup.turnstile_required"),
                });
                return;
              }
              form.clearErrors("turnstileToken");
              try {
                await createUserMutation.mutateAsync({
                  ...value,
                  redirectUrl,
                });
              } catch (e) {
                if (e instanceof TRPCClientError) {
                  setErrorMessage(e.message);
                }
                // Reset turnstile widget on error to get a new token
                if (turnstileSiteKey) {
                  turnstileRef.current?.reset();
                  form.setValue("turnstileToken", "");
                }
                return;
              }
              const resp = await signIn("credentials", {
                redirect: false,
                email: value.email.trim(),
                password: value.password,
              });
              if (!resp || !resp.ok || resp.error) {
                if (resp?.error === VERIFY_EMAIL_ERROR) {
                  router.replace(
                    `/check-email?email=${encodeURIComponent(value.email.trim())}&redirectUrl=${encodeURIComponent(redirectUrl)}`,
                  );
                } else {
                  setErrorMessage(
                    resp?.error ?? t("signup.unexpected_signin_error"),
                  );
                }
                // Reset turnstile widget on error to get a new token
                if (turnstileSiteKey) {
                  turnstileRef.current?.reset();
                  form.setValue("turnstileToken", "");
                }
                return;
              }
              if (isMobileAppRedirect(redirectUrl)) {
                window.location.href = redirectUrl;
              } else {
                router.replace(redirectUrl);
              }
            })}
            className="space-y-4"
          >
            {errorMessage && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            )}

            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("signup.full_name")}</FormLabel>
                  <FormControl>
                    <Input
                      type="text"
                      placeholder={t("signup.full_name_placeholder")}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("signin.email")}</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
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
                      placeholder={t("signup.password_placeholder")}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="confirmPassword"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("signup.confirm_password")}</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder={t("signup.confirm_password_placeholder")}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {turnstileSiteKey && (
              <FormField
                control={form.control}
                name="turnstileToken"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("signup.verification")}</FormLabel>
                    <FormControl>
                      <Turnstile
                        ref={turnstileRef}
                        siteKey={turnstileSiteKey}
                        onSuccess={(token) => {
                          field.onChange(token);
                          form.clearErrors("turnstileToken");
                        }}
                        onExpire={() => field.onChange("")}
                        onError={() => {
                          field.onChange("");
                          form.setError("turnstileToken", {
                            type: "manual",
                            message: t("signup.turnstile_failed"),
                          });
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <ActionButton
              type="submit"
              loading={
                form.formState.isSubmitting || createUserMutation.isPending
              }
              className="w-full"
            >
              {t("signup.submit")}
            </ActionButton>

            {(clientConfig.legal.termsOfServiceUrl ||
              clientConfig.legal.privacyPolicyUrl) && (
              <p className="text-center text-xs text-muted-foreground">
                {t("signup.legal_notice")}{" "}
                {clientConfig.legal.termsOfServiceUrl && (
                  <Link
                    href={clientConfig.legal.termsOfServiceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-foreground"
                  >
                    {t("signup.terms_of_service")}
                  </Link>
                )}
                {clientConfig.legal.termsOfServiceUrl &&
                  clientConfig.legal.privacyPolicyUrl &&
                  t("signup.legal_and")}
                {clientConfig.legal.privacyPolicyUrl && (
                  <Link
                    href={clientConfig.legal.privacyPolicyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-foreground"
                  >
                    {t("signup.privacy_policy")}
                  </Link>
                )}
                .
              </p>
            )}
          </form>
        </Form>

        <div className="text-center">
          <p className="text-sm text-gray-600">
            {t("signup.already_have_account")}{" "}
            <Link
              href="/signin"
              className="font-medium text-blue-600 hover:text-blue-500"
            >
              {t("signin.sign_in")}
            </Link>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
