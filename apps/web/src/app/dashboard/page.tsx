import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
        <p className="muted-text">Live club and player insights will appear here.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Authentication ready</CardTitle>
          <CardDescription>
            Your Discord session and permissions have been verified server-side.
          </CardDescription>
        </CardHeader>
        <CardContent className="muted-text">
          The shared data layer and dashboard metrics are being added in the next milestone.
        </CardContent>
      </Card>
    </div>
  );
}
