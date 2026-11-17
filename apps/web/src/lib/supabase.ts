import { createServerClient } from '@supabase/ssr';
import { getSupabaseConfig } from '@brawlhub/database';
import { cookies } from 'next/headers';

/**
 * Creates a user-scoped Supabase client bound to the current request's cookies.
 *
 * This client intentionally uses the anonymous key only. Never use the service
 * role key here: it must stay server-only and is reserved for trusted jobs.
 */
export async function createServerSupabaseClient() {
  const { url, anonKey } = getSupabaseConfig();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookieOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot write cookies. This is expected and safe
          // to ignore: session refresh is handled by middleware/route handlers.
        }
      },
    },
  });
}
