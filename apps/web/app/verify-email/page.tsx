"use client";

import { useEffect, useState } from "react";
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
import { CheckCircle, Loader2, XCircle } from "lucide-react";

import { useTranslation } from "@/lib/i18n/client";
import { useTRPC } from "@saiye/shared-react/trpc";
import {
  isMobileAppRedirect,
  validateRedirectUrl,
} from "@saiye/shared/utils/redirectUrl";

export default function VerifyEmailPage() {
  const { t } = useTranslation();
  const api = useTRPC();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "success" | "error">(
    "loading",
  );
  const [message, setMessage] = useState("");

  const token = searchParams.get("token");
  const email = searchParams.get("email");
  const redirectUrl =
    validateRedirectUrl(searchParams.get("redirectUrl")) ?? "/";

  const verifyEmailMutation = useMutation(
    api.users.verifyEmail.mutationOptions({
      onSuccess: () => {
        setStatus("success");
        if (isMobileAppRedirect(redirectUrl)) {
          setMessage(t("email_verification.verified_redirect"));
          // Redirect to mobile app after a brief delay
          setTimeout(() => {
            window.location.href = redirectUrl;
          }, 1500);
        } else {
          setMessage(t("email_verification.verified_signin"));
        }
      },
      onError: (error) => {
        setStatus("error");
        setMessage(error.message || t("email_verification.verify_failed"));
      },
    }),
  );

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

  const isMobileRedirect = isMobileAppRedirect(redirectUrl);

  useEffect(() => {
    if (token && email) {
      verifyEmailMutation.mutate({ token, email });
    } else {
      setStatus("error");
      setMessage(t("email_verification.invalid_link"));
    }
  }, [token, email]);

  const handleResendEmail = () => {
    if (email) {
      resendEmailMutation.mutate({ email, redirectUrl });
    }
  };

  const handleSignIn = () => {
    if (isMobileRedirect) {
      window.location.href = redirectUrl;
    } else if (redirectUrl !== "/") {
      router.push(`/signin?redirectUrl=${encodeURIComponent(redirectUrl)}`);
    } else {
      router.push("/signin");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12 sm:px-6 lg:px-8">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">
            {t("email_verification.email_verification")}
          </CardTitle>
          <CardDescription>
            {status === "loading" && t("email_verification.verifying")}
            {status === "success" && t("email_verification.verified")}
            {status === "error" && t("email_verification.verification_failed")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {status === "loading" && (
            <div className="flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
            </div>
          )}

          {status === "success" && (
            <>
              <div className="flex items-center justify-center">
                <CheckCircle className="h-12 w-12 text-green-600" />
              </div>
              <Alert>
                <AlertDescription className="text-center">
                  {message}
                </AlertDescription>
              </Alert>
              <Button onClick={handleSignIn} className="w-full">
                {isMobileRedirect
                  ? t("email_verification.open_app")
                  : t("email_verification.sign_in")}
              </Button>
            </>
          )}

          {status === "error" && (
            <>
              <div className="flex items-center justify-center">
                <XCircle className="h-12 w-12 text-red-600" />
              </div>
              <Alert variant="destructive">
                <AlertDescription className="text-center">
                  {message}
                </AlertDescription>
              </Alert>
              {email && (
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
                    onClick={handleSignIn}
                    variant="ghost"
                    className="w-full"
                  >
                    {t("email_verification.back_to_sign_in")}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
