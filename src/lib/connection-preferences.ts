// Browser-side storage of the user's API key, shared by every surface that
// calls /api/images (the image studio and the infinite canvas). One key, one
// storage entry: entering it in the studio is enough for the canvas too.
//
// Security: only the key is stored. The upstream base URL lives in a
// server-only env var and must never reach localStorage — the legacy endpoint
// key below is read only so it can be deleted from existing browsers.

export const CONNECTION_PREFERENCES_KEY = "imgx.connectionPreferences"

const LEGACY_API_KEY_KEY = "imgx.apiKey"
const LEGACY_REMEMBER_KEY_KEY = "imgx.rememberKey"
const LEGACY_ENDPOINT_KEY = "imgx.endpoint"

export type StoredConnectionPreferences = {
  version: 1
  remember: boolean
  apiKey: string
}

export function readStoredConnectionPreferences(): StoredConnectionPreferences {
  const storedPreferences = localStorage.getItem(CONNECTION_PREFERENCES_KEY)

  if (storedPreferences) {
    try {
      const parsed = JSON.parse(storedPreferences) as Partial<StoredConnectionPreferences>

      if (
        parsed.version === 1 &&
        typeof parsed.remember === "boolean" &&
        typeof parsed.apiKey === "string"
      ) {
        return {
          version: 1,
          remember: parsed.remember,
          apiKey: parsed.apiKey,
        }
      }
    } catch {
      localStorage.removeItem(CONNECTION_PREFERENCES_KEY)
    }
  }

  const remember = localStorage.getItem(LEGACY_REMEMBER_KEY_KEY) === "true"

  return {
    version: 1,
    remember,
    apiKey: remember ? localStorage.getItem(LEGACY_API_KEY_KEY) || "" : "",
  }
}

export function clearStoredConnectionPreferences() {
  localStorage.removeItem(CONNECTION_PREFERENCES_KEY)
  localStorage.removeItem(LEGACY_API_KEY_KEY)
  localStorage.removeItem(LEGACY_REMEMBER_KEY_KEY)
  localStorage.removeItem(LEGACY_ENDPOINT_KEY)
}

export function writeStoredConnectionPreferences({
  apiKey,
}: Pick<StoredConnectionPreferences, "apiKey">) {
  const preferences: StoredConnectionPreferences = {
    version: 1,
    remember: true,
    apiKey,
  }

  localStorage.setItem(CONNECTION_PREFERENCES_KEY, JSON.stringify(preferences))
  localStorage.removeItem(LEGACY_API_KEY_KEY)
  localStorage.removeItem(LEGACY_REMEMBER_KEY_KEY)
  localStorage.removeItem(LEGACY_ENDPOINT_KEY)
}

// Convenience for non-React callers (the canvas provider): returns "" when the
// user has not stored a key, letting the route produce the localized
// "API key required" error instead of us duplicating that copy client-side.
export function getStoredApiKey() {
  if (typeof window === "undefined") {
    return ""
  }

  try {
    return readStoredConnectionPreferences().apiKey.trim()
  } catch {
    return ""
  }
}
