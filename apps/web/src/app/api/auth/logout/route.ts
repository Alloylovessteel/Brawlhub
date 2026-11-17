import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase';

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();

  const url = new URL('/login', request.nextUrl.origin);
  url.searchParams.set('loggedOut', '1');
  return NextResponse.redirect(url, 303);
}
