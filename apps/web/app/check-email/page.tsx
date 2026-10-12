"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Mail } from "lucide-react";

import { useTranslation } from "@/lib/i18n/client";
import { useTRPC } from "@saiye/shared-react/trpc";
import { validateRedirectUrl } from "@saiye/shared/utils/redirectUrl";

export default function CheckEmailPage() {
  const { t } = useTranslation();
  const api = useTRPC();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [message, setMessage] = useState("");

  const email = searchParams.get("email");
  const redirectUrl =
    validateRedirectUrl(searchParams.get("redirectUrl")) ?? "/";

  const resendEmailMutation = useMutation(
    api.users.resendVerificationEmail.mutationOptions({
      onSuccess: () => {
        setMessage(t("email_verification.resend_sent"));
      },
      onError: (error) => {
        setMessage(error.message || t("email_verification.resend_failed"));
      },
    }),
  );

  const handleResendEmail = () => {
    if (email) {
      resendEmailMutation.mutate({ email, redirectUrl });
    }
  };

  const handleBackToSignIn = () => {
    router.push("/signin");
  };

  if (!email) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-bold">
              {t("email_verification.invalid_request")}
            </CardTitle>
            <CardDescription>
              {t("email_verification.no_email_provided")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={handleBackToSignIn} className="w-full">
              {t("email_verification.back_to_sign_in")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">
            {t("email_verification.check_your_email")}
          </CardTitle>
          <CardDescription>{t("email_verification.sent_link")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-center">
            <Mail className="h-12 w-12 text-blue-600" />
          </div>

          <div className="space-y-2 text-center">
            <p className="text-sm text-muted-foreground">
              {t("email_verification.sent_to")}
            </p>
            <p className="font-medium text-foreground">{email}</p>
            <p className="text-sm text-muted-foreground">
              {t("email_verification.click_link_instructions")}
            </p>
          </div>

          {message && (
            <Alert>
              <AlertDescription className="text-center">
                {message}
              </AlertDescription>
            </Alert>
          )}

          <div className="space-y-2">
            <Button
              onClick={handleResendEmail}
              variant="outline"
              className="w-full"
              disabled={resendEmailMutation.isPending}
            >
              {resendEmailMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("email_verification.sending")}
                </>
              ) : (
                t("email_verification.resend_verification_email")
              )}
            </Button>
            <Button
              onClick={handleBackToSignIn}
              variant="ghost"
              className="w-full"
            >
              {t("email_verification.back_to_sign_in")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
