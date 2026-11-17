import Link from 'next/link';
import { LockKeyhole } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function AccessDeniedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center text-center">
          <div className="grid h-12 w-12 place-items-center rounded-full border border-danger/40 bg-danger/10 text-danger">
            <LockKeyhole className="h-5 w-5" aria-hidden />
          </div>
          <CardTitle>Access denied</CardTitle>
          <CardDescription>
            Your account does not have permission to view this area of BrawlHub.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Link href="/dashboard" className={buttonVariants({ variant: 'secondary' })}>
            Return to dashboard
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
