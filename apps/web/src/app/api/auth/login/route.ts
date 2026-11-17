import { NextResponse, type NextRequest } from 'next/server';
import { safeNextPath } from '@/lib/auth/config';
import { createServerSupabaseClient } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const next = safeNextPath(typeof form.get('next') === 'string' ? String(form.get('next')) : null);
  const callback = new URL('/api/auth/callback', request.nextUrl.origin);
  callback.searchParams.set('next', next);

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'discord',
    options: {
      scopes: 'identify email guilds',
      redirectTo: callback.toString(),
    },
  });

  if (error !== null || data.url === null || data.url.length === 0) {
    const url = new URL('/login', request.nextUrl.origin);
    url.searchParams.set('error', 'oauth_start_failed');
    return NextResponse.redirect(url, 303);
  }

  return NextResponse.redirect(data.url, 303);
}
