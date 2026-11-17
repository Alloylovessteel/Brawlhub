import { ShieldCheck, Swords } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { safeNextPath } from '@/lib/auth/config';

const ERROR_MESSAGES: Record<string, string> = {
  oauth_start_failed: 'Discord sign-in could not be started. Please try again.',
  oauth_denied: 'Discord sign-in was cancelled or rejected.',
  oauth_exchange_failed: 'The Discord login response could not be verified.',
  missing_guild_scope: 'Server membership could not be checked. Please sign in again.',
  guild_not_configured: 'The Discord server is not configured for this deployment.',
  not_server_member: 'You must be a member of the configured Discord server to access BrawlHub.',
  provision_failed: 'Your account could not be provisioned. Please contact an administrator.',
};

export default async function LoginPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ error?: string; next?: string; loggedOut?: string }>;
}>) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  const errorMessage =
    params.error === undefined ? null : (ERROR_MESSAGES[params.error] ?? 'Sign-in failed.');

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center justify-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl border border-accent/40 bg-accent/15 text-accent">
            <Swords className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">BrawlHub</h1>
            <p className="text-xs text-muted">Club management for our Discord community</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Private community access</CardTitle>
              <Badge variant="neutral">Discord only</Badge>
            </div>
            <CardDescription>
              Sign in with Discord to view real club rosters, membership history and trophy
              statistics.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {params.loggedOut === '1' ? (
              <p className="rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm text-success">
                You have been signed out.
              </p>
            ) : null}
            {errorMessage === null ? null : (
              <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
                {errorMessage}
              </p>
            )}

            <form action="/api/auth/login" method="post">
              <input type="hidden" name="next" value={next} />
              <Button type="submit" className="w-full">
                Continue with Discord
              </Button>
            </form>

            <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-muted px-3 py-2 text-xs text-muted">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                We verify your Discord server membership and configured roles before granting
                access. Bot tokens and API keys are never sent to the browser.
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
