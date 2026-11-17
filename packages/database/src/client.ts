import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseConfig } from './env';

const NO_SESSION_AUTH = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const;

/**
 * User-scoped client using the public anon key. Row Level Security applies,
 * so no session is persisted and no token is refreshed automatically.
 */
export function createAnonClient(): SupabaseClient {
  const { url, anonKey } = getSupabaseConfig();
  return createClient(url, anonKey, { auth: NO_SESSION_AUTH });
}

/**
 * Trusted server-side client using the service role key. Only use for
 * privileged, non-user-scoped work; never expose this client to browsers.
 */
export function createTrustedClient(): SupabaseClient {
  const { url, serviceRoleKey } = getSupabaseConfig();
  if (serviceRoleKey === undefined) {
    throw new Error(
      'Missing SUPABASE_SERVICE_ROLE_KEY: a trusted Supabase client requires a service role key',
    );
  }
  return createClient(url, serviceRoleKey, { auth: NO_SESSION_AUTH });
}
